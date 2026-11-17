import type { UsageRelayDay, UsageRelayModel, UsageRelaySummary } from "@t3tools/contracts";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Mirrors the provider accents already used elsewhere on the usage page. */
const DONUT_COLORS = [
  "var(--primary)",
  "var(--success)",
  "#d97757",
  "var(--warning)",
  "#5b9bbd",
  "#8c7bd1",
] as const;

function compactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 100) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(abs >= 10 ? 1 : 2)}`;
}

function dayLabel(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

function expiryLabel(iso: string | null): string | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const days = Math.ceil((parsed - Date.now()) / 86_400_000);
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  return days >= 0 ? `${stamp} · 剩 ${days} 天` : `${stamp} · 已过期`;
}

function QuotaBar({ used, limit }: { readonly used: number; readonly limit: number }) {
  const share = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          share >= 0.95 ? "bg-destructive" : share >= 0.75 ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${share * 100}%` }}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="text-lg font-semibold text-foreground tabular-nums">{value}</p>
      {hint === undefined ? null : (
        <p className="text-2xs text-muted-foreground tabular-nums">{hint}</p>
      )}
    </div>
  );
}

function SpendBars({
  days,
  windowDays,
}: {
  readonly days: readonly UsageRelayDay[];
  readonly windowDays: number;
}) {
  const visible = days.slice(-Math.max(1, windowDays));
  if (visible.length === 0) {
    return <p className="py-10 text-sm text-muted-foreground">这个时间窗内没有消耗。</p>;
  }
  const peak = visible.reduce((max, day) => Math.max(max, day.costUsd), 0);
  const axisMax = peak > 0 ? peak : 1;
  const showValues = visible.length <= 14;
  const total = visible.reduce((sum, day) => sum + day.costUsd, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            每日消费
          </p>
          <p className="text-2xl font-semibold text-foreground tabular-nums">{formatUsd(total)}</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-2xs text-muted-foreground tabular-nums">
          <span>峰值 {compactUsd(peak)}</span>
          <span>{visible.length} 天</span>
        </div>
      </div>
      <div className="relative flex h-44 gap-1 pt-5">
        <div className="pointer-events-none absolute inset-x-0 top-5 bottom-6 flex flex-col justify-between text-3xs text-muted-foreground tabular-nums">
          <span className="border-b border-border/40 pb-0.5">{compactUsd(axisMax)}</span>
          <span className="border-b border-border/40 pb-0.5">{compactUsd(axisMax / 2)}</span>
          <span>$0</span>
        </div>
        <div className="flex flex-1 items-end gap-1 ps-12">
          {visible.map((day, index) => {
            const height = axisMax > 0 ? (day.costUsd / axisMax) * 100 : 0;
            return (
              <div
                key={day.day}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              >
                {showValues && day.costUsd > 0 ? (
                  <span className="text-4xs text-muted-foreground tabular-nums">
                    {day.costUsd >= 10 ? Math.round(day.costUsd) : day.costUsd.toFixed(1)}
                  </span>
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div
                        className={cn(
                          "w-full max-w-10 rounded-t-sm bg-primary/60 hover:bg-primary",
                          index === visible.length - 1 && "bg-primary",
                        )}
                        style={{ height: `${Math.max(height, day.costUsd > 0 ? 2 : 0)}%` }}
                      />
                    }
                  />
                  <TooltipPopup>
                    {day.day} · {formatUsd(day.costUsd)} · {formatCount(day.requests)} 次请求
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex gap-1 ps-12">
        {visible.map((day, index) => (
          <span
            key={day.day}
            className={cn(
              "min-w-0 flex-1 text-center text-4xs text-muted-foreground tabular-nums",
              // Keep the axis readable when the window holds many days.
              visible.length > 14 && index % 3 !== 0 && "invisible",
            )}
          >
            {dayLabel(day.day)}
          </span>
        ))}
      </div>
    </div>
  );
}

function ModelDonut({ models }: { readonly models: readonly UsageRelayModel[] }) {
  const top = models.slice(0, 6);
  const total = top.reduce((sum, model) => sum + model.costUsd, 0);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-5">
        <div className="relative size-32 shrink-0">
          <svg viewBox="0 0 132 132" className="size-full -rotate-90">
            <circle
              cx="66"
              cy="66"
              r={radius}
              fill="none"
              stroke="var(--secondary)"
              strokeWidth="20"
            />
            {total > 0
              ? top.map((model, index) => {
                  const share = model.costUsd / total;
                  const dash = share * circumference;
                  const element = (
                    <circle
                      key={model.model}
                      cx="66"
                      cy="66"
                      r={radius}
                      fill="none"
                      stroke={DONUT_COLORS[index % DONUT_COLORS.length]}
                      strokeWidth="20"
                      strokeDasharray={`${dash} ${circumference - dash}`}
                      strokeDashoffset={-offset}
                    />
                  );
                  offset += dash;
                  return element;
                })
              : null}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xs text-muted-foreground">合计</span>
            <span className="text-sm font-semibold text-foreground tabular-nums">
              {compactUsd(total)}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          {top.map((model, index) => (
            <div key={model.model} className="flex min-w-0 items-center gap-2 text-xs">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: DONUT_COLORS[index % DONUT_COLORS.length] }}
              />
              <span className="truncate font-mono text-2xs text-foreground">{model.model}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {total > 0 ? `${((model.costUsd / total) * 100).toFixed(0)}%` : "0%"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-72 border-collapse text-xs">
          <thead>
            <tr className="text-3xs tracking-wide text-muted-foreground uppercase">
              <th className="border-b border-border py-2 text-left font-medium">模型</th>
              <th className="border-b border-border py-2 text-right font-medium">请求</th>
              <th className="border-b border-border py-2 text-right font-medium">Token</th>
              <th className="border-b border-border py-2 text-right font-medium">实际</th>
            </tr>
          </thead>
          <tbody>
            {top.map((model) => (
              <tr key={model.model}>
                <td className="border-b border-border/40 py-2 pr-2 font-mono text-2xs text-foreground">
                  {model.model}
                </td>
                <td className="border-b border-border/40 py-2 text-right text-muted-foreground tabular-nums">
                  {formatCount(model.requests)}
                </td>
                <td className="border-b border-border/40 py-2 text-right text-muted-foreground tabular-nums">
                  {formatTokens(model.totalTokens)}
                </td>
                <td className="border-b border-border/40 py-2 text-right text-success tabular-nums">
                  {formatUsd(model.costUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RelayUsageView({
  relay,
  windowDays,
}: {
  readonly relay: UsageRelaySummary;
  readonly windowDays: number;
}) {
  const used = relay.dailyUsedUsd ?? relay.today.costUsd;
  const limit = relay.dailyLimitUsd;
  const remaining = relay.remainingUsd ?? (limit === null ? null : Math.max(0, limit - used));
  const share = limit !== null && limit > 0 ? Math.min(1, used / limit) : 0;
  const cacheShare =
    relay.today.totalTokens > 0 ? relay.today.cacheReadTokens / relay.today.totalTokens : 0;
  const expiry = expiryLabel(relay.expiresAt);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">{relay.planName ?? "未命名套餐"}</h2>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-2xs",
            relay.isValid
              ? "border-success/40 text-success"
              : "border-destructive/40 text-destructive",
          )}
        >
          {relay.isValid ? "有效" : "失效"}
          {expiry === null ? "" : ` · ${expiry}`}
        </span>
        <span className="rounded-full border border-border px-2.5 py-0.5 text-2xs text-muted-foreground">
          {relay.unit} 额度制{relay.mode === null ? "" : ` · ${relay.mode}`}
        </span>
        <span className="ms-auto text-2xs text-muted-foreground">{relay.endpoint}</span>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              今日已用 / 上限
            </span>
            <span className="text-3xl font-semibold text-foreground tabular-nums">
              {formatUsd(used)}
              {limit === null ? null : (
                <span className="text-base font-normal text-muted-foreground">
                  {" / "}
                  {formatUsd(limit)}
                </span>
              )}
            </span>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              今日剩余
            </span>
            <span className="text-3xl font-semibold text-success tabular-nums">
              {remaining === null ? "n/a" : formatUsd(remaining)}
            </span>
          </div>
        </div>
        {limit === null ? null : <QuotaBar used={used} limit={limit} />}
        <div className="flex flex-wrap justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
          <span>{limit === null ? "无日额度上限" : `${(share * 100).toFixed(1)}% 已用`}</span>
          <span>
            本周 {formatUsd(relay.weeklyUsedUsd ?? 0)}
            {relay.weeklyLimitUsd === null ? "" : ` / ${formatUsd(relay.weeklyLimitUsd)}`} · 本月{" "}
            {formatUsd(relay.monthlyUsedUsd ?? 0)}
            {relay.monthlyLimitUsd === null ? "" : ` / ${formatUsd(relay.monthlyLimitUsd)}`}
          </span>
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="今日 Tokens" value={formatTokens(relay.today.totalTokens)} />
        <Tile label="请求数" value={formatCount(relay.today.requests)} />
        <Tile label="缓存读取" value={formatTokens(relay.today.cacheReadTokens)} />
        <Tile label="缓存命中率" value={`${Math.round(cacheShare * 100)}%`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <SpendBars days={relay.days} windowDays={windowDays} />
        </div>
        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <p className="mb-3 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            按模型实际消费
          </p>
          <ModelDonut models={relay.models} />
        </div>
      </div>
    </div>
  );
}
