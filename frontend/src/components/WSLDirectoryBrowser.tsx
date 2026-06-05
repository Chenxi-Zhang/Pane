import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, Folder, Home, ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/Select';
import { API } from '../utils/api';

interface WSLDirectoryEntry {
  name: string;
  path: string;
}

interface WSLDirectoryBrowserProps {
  onSelect: (wslUncPath: string) => void;
  onCancel?: () => void;
}

export function WSLDirectoryBrowser({ onSelect, onCancel }: WSLDirectoryBrowserProps) {
  const [distros, setDistros] = useState<string[]>([]);
  const [selectedDistro, setSelectedDistro] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [entries, setEntries] = useState<WSLDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingDistros, setLoadingDistros] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await API.wsl.listDistros();
        if (cancelled) return;
        if (res.success && res.data) {
          setDistros(res.data);
          if (res.data.length > 0) {
            setSelectedDistro(res.data[0]);
          }
        }
      } catch {
        if (!cancelled) setError('Failed to detect WSL distributions');
      } finally {
        if (!cancelled) setLoadingDistros(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadDirectory = useCallback(async (distro: string, path: string) => {
    if (!distro || !path) return;
    setLoading(true);
    setError(null);
    try {
      const res = await API.wsl.listDirectory(distro, path);
      if (res.success && res.data) {
        setEntries(res.data);
      } else {
        setError(res.error || 'Failed to list directory');
        setEntries([]);
      }
    } catch {
      setError('Failed to list directory');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedDistro) return;
    let cancelled = false;
    (async () => {
      try {
        const homeRes = await API.wsl.getHome(selectedDistro);
        if (cancelled) return;
        const home = homeRes.success && homeRes.data ? homeRes.data : '/';
        setCurrentPath(home);
      } catch {
        if (!cancelled) setCurrentPath('/');
      }
    })();
    return () => { cancelled = true; };
  }, [selectedDistro]);

  useEffect(() => {
    if (selectedDistro && currentPath) {
      loadDirectory(selectedDistro, currentPath);
    }
  }, [selectedDistro, currentPath, loadDirectory]);

  const handleDistroChange = (distro: string) => {
    setSelectedDistro(distro);
    setCurrentPath('');
    setEntries([]);
  };

  const handleEntryClick = (entry: WSLDirectoryEntry) => {
    setCurrentPath(entry.path);
  };

  const handleSelectHere = () => {
    if (selectedDistro && currentPath) {
      const uncPath = `\\\\wsl.localhost\\${selectedDistro}${currentPath.replace(/\//g, '\\')}`;
      onSelect(uncPath);
    }
  };

  const handleGoUp = () => {
    if (!currentPath || currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath(parts.length > 0 ? '/' + parts.join('/') : '/');
  };

  const breadcrumbs = currentPath ? currentPath.split('/').filter(Boolean) : [];

  if (loadingDistros) {
    return (
      <Card variant="bordered" padding="md" className="text-sm text-text-secondary">
        Detecting WSL distributions...
      </Card>
    );
  }

  if (distros.length === 0) {
    return (
      <Card variant="bordered" padding="md" className="text-sm text-text-secondary">
        No WSL distributions found. Install WSL from the Microsoft Store.
      </Card>
    );
  }

  return (
    <Card variant="bordered" padding="md" className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={selectedDistro} onValueChange={handleDistroChange}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Select distro" />
          </SelectTrigger>
          <SelectContent>
            {distros.map(d => (
              <SelectItem key={d} value={d}>{d}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1 text-xs text-text-secondary ml-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleGoUp}
            disabled={currentPath === '/' || !currentPath}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectedDistro && currentPath && loadDirectory(selectedDistro, currentPath)}
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-0.5 text-xs text-text-secondary flex-wrap min-h-[20px]">
        <button
          className="hover:text-interactive transition-colors flex items-center gap-0.5"
          onClick={() => setCurrentPath('/')}
        >
          <Home className="w-3 h-3" />
        </button>
        {breadcrumbs.map((segment, idx) => {
          const fullPath = '/' + breadcrumbs.slice(0, idx + 1).join('/');
          const isLast = idx === breadcrumbs.length - 1;
          return (
            <span key={fullPath} className="flex items-center gap-0.5">
              <ChevronRight className="w-3 h-3 opacity-40" />
              {isLast ? (
                <span className="text-text-primary font-medium">{segment}</span>
              ) : (
                <button
                  className="hover:text-interactive transition-colors"
                  onClick={() => setCurrentPath(fullPath)}
                >
                  {segment}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {error && (
        <div className="text-xs text-red-400 px-2 py-1 bg-red-500/10 rounded">
          {error}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded border border-border-subtle bg-surface-secondary">
        {loading ? (
          <div className="p-3 text-xs text-text-muted">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="p-3 text-xs text-text-muted">No subdirectories</div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {entries.map(entry => (
              <li key={entry.path}>
                <button
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-text-primary hover:bg-surface-tertiary transition-colors text-left"
                  onClick={() => handleEntryClick(entry)}
                  onDoubleClick={handleSelectHere}
                >
                  <Folder className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                  <span className="truncate">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-between items-center gap-2 pt-1">
        <span className="text-xs text-text-muted font-mono truncate">
          {currentPath || '/'}
        </span>
        <div className="flex gap-2 flex-shrink-0">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSelectHere}
            disabled={!currentPath}
          >
            Select This Folder
          </Button>
        </div>
      </div>
    </Card>
  );
}
