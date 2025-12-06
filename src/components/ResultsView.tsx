import { useState } from 'react';
import { ComparisonResult, Issue } from '../App';
import { IssuesSidebar } from './IssuesSidebar';
import { ImageCompare } from './ImageCompare';
import { ArrowLeft } from 'lucide-react';

interface ResultsViewProps {
  result: ComparisonResult;
  onBack?: () => void;
}

export function ResultsView({ result, onBack }: ResultsViewProps) {
  const [activeTab, setActiveTab] = useState<'design' | 'live' | 'diff'>('diff');
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);

  const currentImage =
    activeTab === 'design'
      ? result.figmaImageUrl
      : activeTab === 'live'
      ? result.screenshotUrl
      : result.diffImageUrl;

  return (
    <div className="flex h-[calc(100vh-180px)]">
      {/* Main Content */}
      <div className="flex-1 overflow-auto bg-zinc-900">
        {/* Tabs */}
        <div className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm">
          <div className="flex items-center gap-1 px-6 pt-4">
            {onBack && (
              <button
                onClick={onBack}
                className="mr-3 flex items-center gap-2 rounded bg-zinc-800 px-3 py-2 font-mono text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
              >
                <ArrowLeft className="size-4" />
                <span>Back</span>
              </button>
            )}
            <button
              onClick={() => setActiveTab('design')}
              className={`rounded-t-lg px-4 py-2 font-mono transition-colors ${
                activeTab === 'design'
                  ? 'bg-zinc-900 text-blue-400 border-t border-x border-zinc-800'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Design
            </button>
            <button
              onClick={() => setActiveTab('live')}
              className={`rounded-t-lg px-4 py-2 font-mono transition-colors ${
                activeTab === 'live'
                  ? 'bg-zinc-900 text-green-400 border-t border-x border-zinc-800'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Live
            </button>
            <button
              onClick={() => setActiveTab('diff')}
              className={`rounded-t-lg px-4 py-2 font-mono transition-colors ${
                activeTab === 'diff'
                  ? 'bg-zinc-900 text-purple-400 border-t border-x border-zinc-800'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Diff
            </button>
            <div className="ml-auto flex items-center gap-3 pb-2">
              <div className="rounded bg-zinc-800 px-3 py-1 font-mono text-zinc-400">
                {result.resolution.width} × {result.resolution.height}
              </div>
              <div
                className={`rounded px-3 py-1 font-mono ${
                  result.diffScore < 0.05
                    ? 'bg-green-950/30 text-green-400'
                    : result.diffScore < 0.15
                    ? 'bg-yellow-950/30 text-yellow-400'
                    : 'bg-red-950/30 text-red-400'
                }`}
              >
                {(result.diffScore * 100).toFixed(2)}% diff
              </div>
            </div>
          </div>
        </div>

        {/* Image Display */}
        <ImageCompare
          imageUrl={currentImage}
          selectedIssue={selectedIssue}
          activeTab={activeTab}
        />
      </div>

      {/* Issues Sidebar */}
      <IssuesSidebar
        issues={result.issues}
        selectedIssue={selectedIssue}
        onSelectIssue={setSelectedIssue}
      />
    </div>
  );
}