'use client';

import { useEffect, useState, useId } from 'react';
import { Cpu, Activity, TrendingUp } from 'lucide-react';
import { getRunMetrics, type Run, type RunMetricsData, type RunMetricPoint } from '@/lib/api';
import { cn } from '@/lib/utils';

const TERMINAL = new Set<Run['status']>(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

interface RunRamUsageProps {
  runId: string;
  status: Run['status'];
  memoryLimitMbytes?: number;
  className?: string;
  compact?: boolean;
}

export function RunRamUsage({
  runId,
  status,
  memoryLimitMbytes = 1024,
  className,
  compact = false,
}: RunRamUsageProps) {
  const [metrics, setMetrics] = useState<RunMetricsData | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<RunMetricPoint | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const gradientId = useId();

  const isLive = !TERMINAL.has(status);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollMetrics() {
      try {
        const data = await getRunMetrics(runId);
        if (!alive) return;
        setMetrics(data);

        if (alive && !TERMINAL.has(data.status as Run['status'])) {
          timer = setTimeout(() => {
            void pollMetrics();
          }, 1500);
        }
      } catch {
        // Quiet fallback — metrics are best-effort decoration
      }
    }

    void pollMetrics();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, status]);

  const limitMb = metrics?.memoryLimitMb || memoryLimitMbytes || 1024;
  const currentMb = metrics?.current?.usedMb ?? null;
  const peakMb = metrics?.peakMemoryMb ?? (currentMb !== null ? currentMb : null);
  const currentPct =
    currentMb !== null && limitMb > 0
      ? Math.min(100, Math.round((currentMb / limitMb) * 1000) / 10)
      : null;
  const peakPct =
    peakMb !== null && limitMb > 0
      ? Math.min(100, Math.round((peakMb / limitMb) * 1000) / 10)
      : null;

  // Percentage color thresholds
  const activePct = currentPct ?? peakPct ?? 0;
  const isHigh = activePct >= 85;
  const isWarn = activePct >= 70 && activePct < 85;

  const toneColor = isHigh ? 'text-fail' : isWarn ? 'text-warn' : 'text-signal';

  const toneBg = isHigh ? 'bg-fail' : isWarn ? 'bg-warn' : 'bg-signal';

  const toneBorder = isHigh ? 'border-fail/40' : isWarn ? 'border-warn/40' : 'border-signal/40';

  // Compact sidebar / runtime view
  if (compact) {
    return (
      <div className={cn('space-y-1.5', className)}>
        <div className="flex items-center justify-between font-mono text-[12px]">
          <span className="text-muted-foreground flex items-center gap-1">
            <Cpu className="h-3 w-3" />
            {isLive && currentMb !== null ? 'Live RAM' : 'Peak RAM'}
          </span>
          <span className={cn('font-medium tnum', toneColor)}>
            {isLive && currentMb !== null
              ? `${currentMb} MB`
              : peakMb !== null
                ? `${peakMb} MB`
                : '—'}
            {activePct > 0 && <span className="opacity-80 text-[10px] ml-1">({activePct}%)</span>}
          </span>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-secondary/80 h-1.5 rounded-full overflow-hidden relative">
          <div
            className={cn('h-full rounded-full transition-all duration-500 ease-out', toneBg)}
            style={{ width: `${Math.max(2, Math.min(100, activePct))}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/70">
          <span>Limit: {limitMb} MB</span>
          {peakMb !== null && isLive && <span>Peak: {peakMb} MB</span>}
        </div>
      </div>
    );
  }

  // History data points for chart
  const history = metrics?.history || [];
  const pointsCount = history.length;

  // Chart dimension constants
  const chartWidth = 600;
  const chartHeight = 130;
  const paddingX = 10;
  const paddingY = 15;
  const usableWidth = chartWidth - paddingX * 2;
  const usableHeight = chartHeight - paddingY * 2;

  // Max scale is either container limit or highest point + 10%
  const maxVal = Math.max(limitMb, ...(history.map((p) => p.usedMb) || [0]), 10);

  const getX = (index: number) => {
    if (pointsCount <= 1) return paddingX + usableWidth / 2;
    return paddingX + (index / (pointsCount - 1)) * usableWidth;
  };

  const getY = (val: number) => {
    return paddingY + usableHeight - (val / maxVal) * usableHeight;
  };

  // Build SVG path
  const pathD = history.reduce((acc, point, i) => {
    const x = getX(i);
    const y = getY(point.usedMb);
    return i === 0 ? `M ${x} ${y}` : `${acc} L ${x} ${y}`;
  }, '');

  // Build Area path for gradient fill
  const areaD =
    history.length > 0
      ? `${pathD} L ${getX(history.length - 1)} ${paddingY + usableHeight} L ${getX(0)} ${
          paddingY + usableHeight
        } Z`
      : '';

  const limitLineY = getY(limitMb);

  return (
    <section className={cn('panel p-5 space-y-4', className)}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/80">
        <div className="flex items-center gap-2">
          <div className={cn('p-1.5 rounded-sm border', toneBorder, 'bg-secondary/40')}>
            <Cpu className={cn('h-4 w-4', toneColor)} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="eyebrow">MEMORY & RAM USAGE</span>
              {isLive ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-xs bg-signal/15 text-signal border border-signal/30">
                  <span className="live-dot" /> LIVE MONITOR
                </span>
              ) : (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-xs bg-secondary text-muted-foreground border border-border">
                  TERMINAL
                </span>
              )}
            </div>
            <p className="text-[12px] text-muted-foreground mt-0.5">
              Working-set container RAM (page cache excluded) sampled every 1s
            </p>
          </div>
        </div>

        {/* Live / Peak Metrics summary badges */}
        <div className="flex items-center gap-3 font-mono text-[12px]">
          {isLive && currentMb !== null && (
            <div className="px-2.5 py-1 rounded-sm bg-secondary/80 border border-border">
              <span className="text-muted-foreground text-[10px] uppercase block">Current</span>
              <span className={cn('font-semibold tnum text-[13px]', toneColor)}>
                {currentMb} MB <span className="text-[11px] font-normal">({currentPct}%)</span>
              </span>
            </div>
          )}

          {peakMb !== null && (
            <div className="px-2.5 py-1 rounded-sm bg-secondary/80 border border-border">
              <span className="text-muted-foreground text-[10px] uppercase block">Peak</span>
              <span className="font-semibold text-foreground tnum text-[13px]">
                {peakMb} MB{' '}
                {peakPct !== null && (
                  <span className="text-[11px] text-muted-foreground font-normal">
                    ({peakPct}%)
                  </span>
                )}
              </span>
            </div>
          )}

          <div className="px-2.5 py-1 rounded-sm bg-secondary/80 border border-border">
            <span className="text-muted-foreground text-[10px] uppercase block">Limit</span>
            <span className="font-semibold text-foreground tnum text-[13px]">{limitMb} MB</span>
          </div>
        </div>
      </div>

      {/* Progress Bar & Warning Indicator */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between font-mono text-[11px]">
          <span className="text-muted-foreground">
            {isLive ? 'Current Allocation' : 'Peak Memory Reached'}
          </span>
          <span className={cn('font-medium tnum', toneColor)}>
            {activePct}% used {isHigh && '— Close to OOM threshold!'}
          </span>
        </div>

        <div className="w-full bg-secondary h-2.5 rounded-sm overflow-hidden relative border border-border/40">
          <div
            className={cn('h-full transition-all duration-300 ease-out', toneBg)}
            style={{ width: `${Math.max(1, Math.min(100, activePct))}%` }}
          />
        </div>
      </div>

      {/* Real-time SVG Time Series Graph */}
      <div className="relative border border-border/60 rounded-sm bg-background/80 p-3 overflow-hidden">
        <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground mb-2">
          <span className="flex items-center gap-1">
            <TrendingUp className="h-3 w-3 text-signal" />
            MEMORY TIMELINE (MB vs TIME)
          </span>
          <span>{history.length} samples collected</span>
        </div>

        {history.length > 1 ? (
          <div
            className="relative w-full overflow-hidden"
            onMouseLeave={() => {
              setHoveredPoint(null);
              setHoverX(null);
            }}
          >
            <svg
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              className="w-full h-32 overflow-visible"
              preserveAspectRatio="none"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
                const svgX = (mouseX / rect.width) * chartWidth;
                const index = Math.round(((svgX - paddingX) / usableWidth) * (history.length - 1));
                if (index >= 0 && index < history.length) {
                  setHoveredPoint(history[index]);
                  setHoverX(getX(index));
                }
              }}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={isHigh ? '#cf222e' : isWarn ? '#d97706' : '#22c55e'}
                    stopOpacity="0.4"
                  />
                  <stop
                    offset="100%"
                    stopColor={isHigh ? '#cf222e' : isWarn ? '#d97706' : '#22c55e'}
                    stopOpacity="0.0"
                  />
                </linearGradient>
              </defs>

              {/* Background horizontal grid lines */}
              <line
                x1={paddingX}
                y1={getY(limitMb * 0.5)}
                x2={chartWidth - paddingX}
                y2={getY(limitMb * 0.5)}
                stroke="currentColor"
                strokeOpacity="0.1"
                strokeDasharray="4 4"
              />

              {/* Memory Limit Ceiling Line */}
              <line
                x1={paddingX}
                y1={limitLineY}
                x2={chartWidth - paddingX}
                y2={limitLineY}
                stroke="currentColor"
                strokeOpacity="0.25"
                strokeDasharray="3 3"
              />

              {/* Area fill */}
              <path d={areaD} fill={`url(#${gradientId})`} />

              {/* Line stroke */}
              <path
                d={pathD}
                fill="none"
                stroke={isHigh ? '#cf222e' : isWarn ? '#d97706' : '#22c55e'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Crosshair on hover */}
              {hoverX !== null && hoveredPoint && (
                <>
                  <line
                    x1={hoverX}
                    y1={paddingY}
                    x2={hoverX}
                    y2={chartHeight - paddingY}
                    stroke="currentColor"
                    strokeOpacity="0.5"
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={hoverX}
                    cy={getY(hoveredPoint.usedMb)}
                    r="4"
                    fill={isHigh ? '#cf222e' : isWarn ? '#d97706' : '#22c55e'}
                    stroke="var(--background)"
                    strokeWidth="2"
                  />
                </>
              )}
            </svg>

            {/* Memory Limit Ceiling Label */}
            <div
              className="absolute pointer-events-none text-[9px] font-mono text-muted-foreground/60 select-none -translate-y-full pb-0.5 leading-none"
              style={{
                top: `${(limitLineY / chartHeight) * 100}%`,
                right: `calc(${(paddingX / chartWidth) * 100}% + 4px)`,
              }}
            >
              LIMIT: {limitMb} MB
            </div>

            {/* Hover tooltip */}
            {hoveredPoint && hoverX !== null && (
              <div
                className="absolute top-2 pointer-events-none px-2 py-1 rounded bg-popover/95 border border-border shadow-md text-[11px] font-mono z-10 -translate-x-1/2"
                style={{
                  left: `${(hoverX / chartWidth) * 100}%`,
                }}
              >
                <div className="font-semibold text-foreground">{hoveredPoint.usedMb} MB</div>
                <div className="text-[9px] text-muted-foreground">
                  {hoveredPoint.percent}% of {limitMb} MB
                </div>
                <div className="text-[9px] text-muted-foreground/70">
                  {new Date(hoveredPoint.timestamp).toISOString().split('T')[1].slice(0, 8)}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="h-28 flex flex-col items-center justify-center text-muted-foreground/60 text-center font-mono text-[11px]">
            {isLive ? (
              <>
                <Activity className="h-5 w-5 animate-pulse text-signal mb-1.5" />
                <span>Gathering real-time container memory metrics...</span>
              </>
            ) : (
              <span>No extended time-series data recorded for this run</span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/60 mt-2 pt-2 border-t border-border/40">
          <span>0 MB</span>
          <span>50% ({Math.round(limitMb / 2)} MB)</span>
          <span>100% ({limitMb} MB)</span>
        </div>
      </div>
    </section>
  );
}
