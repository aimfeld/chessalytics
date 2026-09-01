import * as React from "react"
import * as RechartsPrimitive from "recharts"
// recharts 3: LegendProps no longer exposes 'payload' (it is Omit<DefaultLegendContentProps,
// 'payload'>). Import from DefaultLegendContentProps which still carries payload.
import type { Props as DefaultLegendContentProps } from "recharts/types/component/DefaultLegendContent"

import { cn } from "@/lib/utils"

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: "", dark: ".dark" } as const

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
}

type ChartContextProps = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />")
  }

  return context
}

type ChartSize = { width: number; height: number }

/**
 * The referenced element's measured size, or null while it is unmeasured or
 * has no size at all (a `display: none` subtree).
 *
 * BUG FIX: recharts 3's ResponsiveContainer console-warns "The width(...) and
 * height(...) of chart should be greater than 0" whenever it renders at a
 * non-positive size, and that happens constantly: once per mount with (-1, -1)
 * (its `initialDimension` default, before its own ResizeObserver has run), and
 * again for every container that really is 0x0 — chiefly the duplicate mobile
 * card bodies that `lg:hidden` keeps mounted as `display: none` (one per game
 * card in the library, hence dozens). The warning is NOT dev-gated in the
 * shipped recharts build (`isDev` is hardcoded `true` in its LogUtils), so it
 * spams the production console too. Measuring here lets ChartContainer keep the
 * chart out of the tree until it has a size, and hand recharts that size as its
 * `initialDimension` so its first render is already correct. recharts renders
 * nothing at a non-positive size anyway, so no output is lost.
 */
function useMeasuredSize(ref: React.RefObject<HTMLDivElement | null>): ChartSize | null {
  const [size, setSize] = React.useState<ChartSize | null>(null)

  React.useEffect(() => {
    const el = ref.current
    if (el == null) return
    // jsdom runs no layout engine, so every rect there is 0x0 — gating on a
    // measurement would hide the chart from every test. Detect that (the body
    // itself measures empty) and render unconditionally instead.
    const hasLayoutEngine = document.body.getBoundingClientRect().height > 0
    if (!hasLayoutEngine || typeof ResizeObserver === "undefined") {
      setSize({ width: 0, height: 0 })
      return
    }
    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      setSize(width > 0 && height > 0 ? { width, height } : null)
    }
    measure()
    // A display:none element is still observed, and fires once it is shown —
    // so a hidden breakpoint tree mounts its chart when it becomes visible.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return size
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >["children"]
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`
  const containerRef = React.useRef<HTMLDivElement>(null)
  const size = useMeasuredSize(containerRef)

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className
        )}
        {...props}
        ref={containerRef}
      >
        <ChartStyle id={chartId} config={config} />
        {size && (
          <RechartsPrimitive.ResponsiveContainer initialDimension={size}>
            {children}
          </RechartsPrimitive.ResponsiveContainer>
        )}
      </div>
    </ChartContext.Provider>
  )
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(
    ([, config]) => config.theme || config.color
  )

  if (!colorConfig.length) {
    return null
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color =
      itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ||
      itemConfig.color
    return color ? `  --color-${key}: ${color};` : null
  })
  .join("\n")}
}
`
          )
          .join("\n"),
      }}
    />
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip

const ChartLegend = RechartsPrimitive.Legend

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
  hiddenKeys,
  onClickItem,
}: React.ComponentProps<"div"> &
  // recharts 3: payload lives on DefaultLegendContentProps, not LegendProps.
  // payload is injected by recharts via cloneElement when used as Legend content.
  Pick<DefaultLegendContentProps, "payload" | "verticalAlign"> & {
    hideIcon?: boolean
    nameKey?: string
    hiddenKeys?: Set<string>
    onClickItem?: (dataKey: string) => void
  }) {
  const { config } = useChart()

  if (!payload?.length) {
    return null
  }

  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-x-4 gap-y-1 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className
      )}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item) => {
          const key = `${nameKey || item.dataKey || "value"}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)
          const isHidden = hiddenKeys?.has(key) ?? false

          return (
            <div
              key={item.value}
              className={cn(
                "flex min-w-0 items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground",
                onClickItem && "cursor-pointer",
                isHidden && "opacity-50 line-through"
              )}
              onClick={onClickItem ? () => onClickItem(key) : undefined}
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{
                    backgroundColor: item.color,
                  }}
                />
              )}
              <span className="truncate sm:max-w-[14rem]">{itemConfig?.label}</span>
            </div>
          )
        })}
    </div>
  )
}

function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: unknown,
  key: string
) {
  if (typeof payload !== "object" || payload === null) {
    return undefined
  }

  const payloadPayload =
    "payload" in payload &&
    typeof payload.payload === "object" &&
    payload.payload !== null
      ? payload.payload
      : undefined

  let configLabelKey: string = key

  if (
    key in payload &&
    typeof payload[key as keyof typeof payload] === "string"
  ) {
    configLabelKey = payload[key as keyof typeof payload] as string
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
  ) {
    configLabelKey = payloadPayload[
      key as keyof typeof payloadPayload
    ] as string
  }

  return configLabelKey in config
    ? config[configLabelKey]
    : config[key as keyof typeof config]
}

export {
  ChartContainer,
  ChartTooltip,
  ChartLegend,
  ChartLegendContent,
}
