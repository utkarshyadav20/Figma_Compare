# UI Compare Lab - Implementation Notes

## 🎯 What's Built

A visual testing tool that compares Figma designs with live websites and highlights differences.

## ✅ Currently Working

### Frontend (100% Complete)
- ✅ Split-panel layout (Figma left, Browser right)
- ✅ Figma URL parser (extracts fileKey + nodeId)
- ✅ Action bar with Compare UI button
- ✅ Results view with tabs (Design, Live, Diff)
- ✅ Issues sidebar with severity levels
- ✅ Image zoom and highlighting
- ✅ Click issues to highlight regions
- ✅ Responsive dark mode UI

### Backend (Partial - Figma API ✅, Screenshot ⚠️)
- ✅ Figma API integration
  - Parse Figma URLs
  - Fetch frame dimensions (width × height)
  - Export frame as PNG
- ✅ Mock comparison results (for demo)
- ⚠️ Screenshot capture (requires external service - see below)
- ⚠️ Image diff processing (requires Playwright environment)

## 🔧 Setup Instructions

### 1. Get Figma Personal Access Token

1. Go to https://www.figma.com/developers/api#access-tokens
2. Click "Get personal access token"
3. Copy your token
4. In Figma Make, you'll be prompted to enter it as `FIGMA_ACCESS_TOKEN`

### 2. How to Use

1. **Enter Figma URL** (left panel)
   - Example: `https://www.figma.com/design/Dvx4WBd3xk5gyAAI5I9qOK/UI-Mismatch--Telekom-malaysia?node-id=2417-63336&t=cpKxki4osQjOEJ3x-1`
   - App will extract fileKey and nodeId automatically

2. **Enter Website URL** (right panel)
   - Example: `https://yourwebsite.com`

3. **Click "Compare UI"**
   - Currently returns mock data with real Figma image
   - Shows detected issues in sidebar

## ⚠️ Current Limitations

### Screenshot Capture
Puppeteer/Playwright require Chrome binaries which are **NOT available in Deno Deploy** (Supabase Edge Functions runtime).

**Solutions:**

#### Option A: Use Screenshot API Service (Recommended for production)
Replace the mock screenshot logic with:

```typescript
// Use a service like:
// - https://screenshotapi.net
// - https://urlbox.io
// - https://browserless.io

const screenshotUrl = `https://shot.screenshotapi.net/screenshot?token=${token}&url=${encodeURIComponent(websiteUrl)}&width=${width}&height=${height}&output=image&file_type=png&wait_for_event=load`;
```

#### Option B: Deploy to Platform with Puppeteer Support
- **Render**: Supports Puppeteer out of the box
- **Railway**: Supports Puppeteer
- **Fly.io**: Supports Puppeteer
- **AWS Lambda**: Use Chrome Layer

Example Puppeteer code (for supported platforms):

```typescript
import puppeteer from 'puppeteer';

async function captureScreenshot(url: string, width: number, height: number) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle2' });
  
  const screenshot = await page.screenshot({ type: 'png' });
  await browser.close();
  
  return screenshot;
}
```

### Image Diff Processing
Currently returns mock diff. For real implementation:

```typescript
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

async function compareImages(img1Buffer: Buffer, img2Buffer: Buffer) {
  const img1 = PNG.sync.read(img1Buffer);
  const img2 = PNG.sync.read(img2Buffer);
  
  const { width, height } = img1;
  const diff = new PNG({ width, height });
  
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    width,
    height,
    { threshold: 0.1 }
  );
  
  const diffBuffer = PNG.sync.write(diff);
  const diffScore = mismatchedPixels / (width * height);
  
  return { diffBuffer, diffScore };
}
```

### Semantic Issue Detection
Currently returns hardcoded mock issues. For real implementation:

```typescript
import { chromium } from 'playwright';

async function analyzeDOM(url: string, regions: Array<{x, y}>) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  
  const issues = [];
  
  for (const region of regions) {
    const element = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      
      const styles = getComputedStyle(el);
      return {
        fontSize: styles.fontSize,
        color: styles.color,
        backgroundColor: styles.backgroundColor,
        padding: styles.padding,
      };
    }, region);
    
    // Compare with Figma metadata
    if (element) {
      // Add logic to detect font/color/padding mismatches
    }
  }
  
  await browser.close();
  return issues;
}
```

## 📦 Image Storage

When implementing real screenshots, use Supabase Storage:

```typescript
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Create bucket on first run
const bucketName = 'make-70da446d-screenshots';
const { data: buckets } = await supabase.storage.listBuckets();
if (!buckets?.some(b => b.name === bucketName)) {
  await supabase.storage.createBucket(bucketName, { public: false });
}

// Upload screenshot
const fileName = `${Date.now()}-screenshot.png`;
await supabase.storage
  .from(bucketName)
  .upload(fileName, screenshotBuffer, { contentType: 'image/png' });

// Get signed URL (valid for 1 hour)
const { data } = await supabase.storage
  .from(bucketName)
  .createSignedUrl(fileName, 3600);

return data.signedUrl;
```

## 🚀 Recommended Next Steps

1. **Quick Demo**: Use mock data (already working!)
2. **Production Screenshot**: Integrate ScreenshotAPI.net or similar service
3. **Real Diff**: Add pixelmatch library (works in Deno)
4. **Image Storage**: Use Supabase Storage for results
5. **Advanced Analysis**: Add DOM inspection for semantic issues

## 📝 API Contract

### POST /make-server-70da446d/compare-ui

**Request:**
```json
{
  "figmaUrl": "https://www.figma.com/design/{fileKey}/...?node-id={nodeId}",
  "websiteUrl": "https://example.com"
}
```

**Response:**
```json
{
  "figmaImageUrl": "https://...",
  "screenshotUrl": "https://...",
  "diffImageUrl": "https://...",
  "diffScore": 0.08,
  "resolution": {
    "width": 1440,
    "height": 900
  },
  "issues": [
    {
      "id": "1",
      "type": "Font|Color|Layout|Padding|Spacing",
      "message": "Font size mismatch: design 18px, live 16px",
      "severity": "Low|Medium|High",
      "region": {
        "x": 50,
        "y": 100,
        "width": 200,
        "height": 40
      }
    }
  ]
}
```

## 🎨 UI Features Implemented

- Dark mode developer tool aesthetic
- Split-panel layout with Figma + Browser
- Real-time URL parsing
- Device preset buttons (Mobile/Tablet/Web/TV)
- Zoom controls (25% - 400%)
- Grid overlay toggle
- Results tabs (Design/Live/Diff)
- Issues categorized by type
- Severity indicators (High/Medium/Low)
- Click to highlight issues on image
- Responsive layout

## 🔑 Environment Variables Needed

- `FIGMA_ACCESS_TOKEN` - Your Figma personal access token (already prompted)
- `SUPABASE_URL` - Auto-provided by Figma Make
- `SUPABASE_SERVICE_ROLE_KEY` - Auto-provided by Figma Make

## 💡 Tips

1. **Test with simple Figma frames first** - small components work best
2. **Use frames with clear bounding boxes** - avoid auto-layout groups
3. **Website must be publicly accessible** - screenshot service needs to reach it
4. **CORS may block some sites** - use your own sites for testing

---

Built with Figma Make 🎨
