import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { Buffer } from 'node:buffer';
import dotenv from 'dotenv';
import fs from 'node:fs';

// Load environment variables
dotenv.config();

const app = new Hono();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Constants
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MIN_API_CALL_INTERVAL = 3000; // 3 seconds

// In-memory cache
const cache = new Map();
let lastFigmaApiCall = 0;

// Rate Limit Error
class RateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfterMs;
  }
}

// Helpers
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForRateLimit() {
  const now = Date.now();
  const timeSinceLastCall = now - lastFigmaApiCall;

  if (timeSinceLastCall < MIN_API_CALL_INTERVAL) {
    const waitTime = MIN_API_CALL_INTERVAL - timeSinceLastCall;
    console.log(`Rate limit protection: waiting ${waitTime}ms`);
    await delay(waitTime);
  }

  lastFigmaApiCall = Date.now();
}

async function getCached(key, fetcher, ttl = CACHE_TTL) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < ttl) {
    console.log('Cache hit for:', key);
    return cached.data;
  }

  console.log('Cache miss for:', key);
  const data = await fetcher();
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

async function retryWithBackoff(fn, maxRetries = 5, initialDelay = 2000) {
  let lastError = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (error instanceof RateLimitError) {
        let waitTime = error.retryAfter;
        if (waitTime < 1000) waitTime = initialDelay * Math.pow(2, i);
        console.log(`Rate limit hit (explicit), waiting ${waitTime}ms (attempt ${i + 1}/${maxRetries})...`);
        await delay(waitTime);
        continue;
      }

      if (error instanceof Error && error.message.includes('429')) {
        const delayMs = initialDelay * Math.pow(2, i);
        console.log(`Rate limit hit (429), waiting ${delayMs}ms (attempt ${i + 1}/${maxRetries})...`);
        await delay(delayMs);
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

function parseFigmaUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const pathParts = url.pathname.split('/');
    const fileKey = pathParts[2] || null;
    let nodeId = url.searchParams.get('node-id');

    if (nodeId) {
      nodeId = nodeId.replace(/-/g, ':');
    }

    return { fileKey, nodeId };
  } catch {
    return { fileKey: null, nodeId: null };
  }
}

// Figma API Functions
async function fetchFigmaFrameData(fileKey, nodeId, token) {
  try {
    await waitForRateLimit();
    console.log(`Fetching Figma node data for ${nodeId}...`);

    const response = await retryWithBackoff(async () => {
      const res = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
        { headers: { 'X-Figma-Token': token } }
      );

      if (!res.ok) {
        if (res.status === 429) {
          const retryAfterHeader = res.headers.get('Retry-After');
          if (retryAfterHeader) {
            const seconds = parseInt(retryAfterHeader, 10);
            if (!isNaN(seconds)) throw new RateLimitError('Figma API rate limit exceeded', seconds * 1000);
          }
          throw new Error(`Figma API error ${res.status}: Rate limit exceeded`);
        }
        const errorText = await res.text();
        throw new Error(`Figma API error ${res.status}: ${errorText}`);
      }
      return res;
    });

    const data = await response.json();
    const node = data.nodes ? data.nodes[nodeId] : null;

    if (!node || !node.document || !node.document.absoluteBoundingBox) {
        throw new Error('Invalid node structure or no bounding box found.');
    }

    return {
      dimensions: {
        width: Math.round(node.document.absoluteBoundingBox.width),
        height: Math.round(node.document.absoluteBoundingBox.height),
      },
    };
  } catch (error) {
    console.error('Error fetching Figma frame data:', error);
    throw error;
  }
}

async function exportFigmaImage(fileKey, nodeId, token) {
  try {
    await waitForRateLimit();
    console.log(`Exporting Figma image for node ${nodeId}...`);

    const response = await retryWithBackoff(async () => {
      const res = await fetch(
        `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=1`,
        { headers: { 'X-Figma-Token': token } }
      );

      if (!res.ok) {
         if (res.status === 429) {
            const retryAfterHeader = res.headers.get('Retry-After');
            if (retryAfterHeader) {
                const seconds = parseInt(retryAfterHeader, 10);
                if (!isNaN(seconds)) throw new RateLimitError('Figma API rate limit exceeded', seconds * 1000);
            }
            throw new Error(`Figma API error ${res.status}: Rate limit exceeded`);
         }
         const errorText = await res.text();
         throw new Error(`Figma Images API error ${res.status}: ${errorText}`);
      }
      return res;
    });

    const data = await response.json();
    const imageUrl = data.images[nodeId];
    if (!imageUrl) throw new Error('No image URL returned from Figma API.');
    return imageUrl;
  } catch (error) {
    console.error('Error exporting Figma image:', error);
    throw error;
  }
}

// Comparison Logic
function resizeImage(png, targetWidth, targetHeight) {
  if (png.width === targetWidth && png.height === targetHeight) return png;

  const resized = new PNG({ width: targetWidth, height: targetHeight });
  const scaleX = png.width / targetWidth;
  const scaleY = png.height / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const srcX = Math.floor(x * scaleX);
      const srcY = Math.floor(y * scaleY);
      const srcIdx = (srcY * png.width + srcX) * 4;
      const dstIdx = (y * targetWidth + x) * 4;

      resized.data[dstIdx] = png.data[srcIdx];
      resized.data[dstIdx + 1] = png.data[srcIdx + 1];
      resized.data[dstIdx + 2] = png.data[srcIdx + 2];
      resized.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return resized;
}

function analyzeImageDifferences(screenshot, figma, width, height) {
    const issues = [];
    const regionSize = 100;
    const regionsX = Math.ceil(width / regionSize);
    const regionsY = Math.ceil(height / regionSize);
  
    for (let ry = 0; ry < regionsY; ry++) {
      for (let rx = 0; rx < regionsX; rx++) {
        const x = rx * regionSize;
        const y = ry * regionSize;
        const w = Math.min(regionSize, width - x);
        const h = Math.min(regionSize, height - y);
  
        let diffPixels = 0;
        let totalPixels = 0;
        let avgColorDiff = 0;
  
        for (let py = y; py < y + h; py++) {
          for (let px = x; px < x + w; px++) {
            const idx = (py * width + px) * 4;
            const rDiff = Math.abs(screenshot.data[idx] - figma.data[idx]);
            const gDiff = Math.abs(screenshot.data[idx + 1] - figma.data[idx + 1]);
            const bDiff = Math.abs(screenshot.data[idx + 2] - figma.data[idx + 2]);
            const pixelDiff = (rDiff + gDiff + bDiff) / 3;
            avgColorDiff += pixelDiff;
            if (pixelDiff > 25) diffPixels++;
            totalPixels++;
          }
        }
  
        avgColorDiff = avgColorDiff / totalPixels;
        const diffPercentage = diffPixels / totalPixels;
  
        if (diffPercentage > 0.1) {
          let type = 'Layout';
          let message = `Region has ${(diffPercentage * 100).toFixed(0)}% pixel differences`;
          let severity = 'Low';
  
          if (avgColorDiff > 100) {
            type = 'Color';
            message = `Significant color mismatch detected (avg diff: ${avgColorDiff.toFixed(0)})`;
            severity = 'High';
          } else if (diffPercentage > 0.5) {
            type = 'Layout';
            message = `Major layout differences detected (${(diffPercentage * 100).toFixed(0)}% different)`;
            severity = 'High';
          } else if (avgColorDiff > 50) {
            type = 'Color';
            message = `Moderate color differences (avg diff: ${avgColorDiff.toFixed(0)})`;
            severity = 'Medium';
          } else if (diffPercentage > 0.25) {
            severity = 'Medium';
          }
  
          issues.push({ id: `region-${rx}-${ry}`, type, message, severity, region: { x, y, width: w, height: h } });
        }
      }
    }
    return issues.sort((a, b) => {
        const severityOrder = { High: 3, Medium: 2, Low: 1 };
        return severityOrder[b.severity] - severityOrder[a.severity];
    }).slice(0, 10);
  }

async function performComparison(websiteUrl, figmaImageUrl, dimensions, screenshotBase64) {
    if (!screenshotBase64) {
        throw new Error("Client-side screenshot is required for local comparison.");
    }

    // 1. Prepare Screenshot
    if (!screenshotBase64) throw new Error('Screenshot is missing/empty');
    console.log(`Screenshot base64 length: ${screenshotBase64.length}`);
    const cleanBase64 = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
    const screenshotBuffer = Buffer.from(cleanBase64, 'base64');
    console.log(`Screenshot buffer size: ${screenshotBuffer.length}`);
    
    // Check for PNG signature in screenshot
    if (screenshotBuffer.length > 0 && screenshotBuffer[0] !== 0x89) {
         console.warn("Screenshot buffer does not start with PNG signature!");
         console.log("First bytes:", screenshotBuffer.subarray(0, 16).toString('hex'));
    }
    
    const screenshotPng = PNG.sync.read(screenshotBuffer);

    // 2. Download Figma Image
    console.log(`Downloading Figma image from: ${figmaImageUrl}`);
    const figmaResponse = await fetch(figmaImageUrl);
    if (!figmaResponse.ok) throw new Error(`Failed to download Figma image: ${figmaResponse.status}`);
    
    const contentType = figmaResponse.headers.get('content-type');
    console.log(`Figma image content-type: ${contentType}`);
    
    const figmaArrayBuffer = await figmaResponse.arrayBuffer();
    const figmaBuffer = Buffer.from(figmaArrayBuffer);
    console.log(`Figma buffer size: ${figmaBuffer.length}`);
    
    // Check for PNG signature in Figma image
    if (figmaBuffer.length > 0 && figmaBuffer[0] !== 0x89) {
         console.warn("Figma buffer does not start with PNG signature!");
         console.log("First bytes:", figmaBuffer.subarray(0, 100).toString()); // Log as string to see if it's text
    }

    const figmaPng = PNG.sync.read(figmaBuffer);

    // 3. Match Dimensions
    const width = Math.min(screenshotPng.width, figmaPng.width, dimensions.width);
    const height = Math.min(screenshotPng.height, figmaPng.height, dimensions.height);
    console.log(`Comparing images at ${width}x${height}...`);

    const resizedScreenshot = resizeImage(screenshotPng, width, height);
    const resizedFigma = resizeImage(figmaPng, width, height);

    // 4. Pixelmatch
    const diffPng = new PNG({ width, height });
    const diffPixels = pixelmatch(
        resizedScreenshot.data,
        resizedFigma.data,
        diffPng.data,
        width,
        height,
        { threshold: 0.7 }
    );

    const diffScore = diffPixels / (width * height);
    console.log(`Diff score: ${(diffScore * 100).toFixed(2)}%`);

    // 5. Analyze
    const issues = analyzeImageDifferences(resizedScreenshot, resizedFigma, width, height);

    // 6. Return Base64 Images (No Supabase Storage)
    const diffBuffer = PNG.sync.write(diffPng);
    
    // We can just return the Figma buffer as base64 too, or reuse the URL if we want. 
    // Usually local usage is fine with Data URLs.
    
    return {
        figmaImageUrl: `data:image/png;base64,${figmaBuffer.toString('base64')}`,
        screenshotUrl: `data:image/png;base64,${screenshotBuffer.toString('base64')}`,
        diffImageUrl: `data:image/png;base64,${diffBuffer.toString('base64')}`,
        diffScore,
        resolution: { width, height },
        issues,
    };
}


// --- Routes ---

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/figma-metadata', async (c) => {
    try {
        const { figmaUrl } = await c.req.json();
        if (!figmaUrl) return c.json({ error: 'Missing figmaUrl' }, 400);

        const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
        if (!fileKey || !nodeId) return c.json({ error: 'Invalid Figma URL' }, 400);

        const token = process.env.FIGMA_ACCESS_TOKEN;
        if (!token) return c.json({ error: 'FIGMA_ACCESS_TOKEN not configured in .env' }, 500);

        const frameData = await getCached(
            `frame-data-${fileKey}-${nodeId}`,
            () => fetchFigmaFrameData(fileKey, nodeId, token)
        );

        return c.json(frameData);
    } catch (error) {
        console.error('Error in figma-metadata:', error);
        return c.json({ error: 'Failed to fetch metadata', details: error.message }, 500);
    }
});

app.post('/compare-ui', async (c) => {
    try {
        const { figmaUrl, websiteUrl, screenshot, dimensions, figmaImageUrl: providedFigmaImageUrl } = await c.req.json();

        if (!figmaUrl || !websiteUrl) return c.json({ error: 'Missing logic' }, 400);

        const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
        const token = process.env.FIGMA_ACCESS_TOKEN;

        let frameDimensions = dimensions;
        if (!frameDimensions) {
             const frameData = await getCached(
                `frame-data-${fileKey}-${nodeId}`,
                () => fetchFigmaFrameData(fileKey, nodeId, token)
             );
             frameDimensions = frameData.dimensions;
        }

        let finalFigmaImageUrl = providedFigmaImageUrl;
        if (!finalFigmaImageUrl) {
            finalFigmaImageUrl = await getCached(
                `figma-image-${fileKey}-${nodeId}`,
                () => exportFigmaImage(fileKey, nodeId, token)
            );
        }
        console.log("Here*************",finalFigmaImageUrl)
        const result = await performComparison(
            websiteUrl,
            finalFigmaImageUrl,
            frameDimensions,
            screenshot // Must be provided
        );

        return c.json(result);

    } catch (error) {
        console.error('Error in compare-ui:', error);
        return c.json({ error: 'Comparison failed', details: error.message }, 500);
    }
});

const port = 3001;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port
});
