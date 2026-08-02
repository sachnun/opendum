import { useId, type SVGProps } from "react";

export interface PointCoinIconProps extends SVGProps<SVGSVGElement> {
  reverse?: boolean;
}

export function PointCoinIcon({ reverse, ...props }: PointCoinIconProps) {
  const idPrefix = useId().replace(/:/g, "");
  const faceId = `${idPrefix}-coin-face`;
  const backId = `${idPrefix}-coin-back`;
  const rimId = `${idPrefix}-coin-rim`;
  const faceStops = reverse ? ["#404040", "#737373", "#FAFAFA"] : ["#FAFAFA", "#A3A3A3", "#404040"];
  const backStops = reverse ? ["#262626", "#737373", "#E5E5E5"] : ["#E5E5E5", "#737373", "#262626"];
  const rimStops = reverse ? ["#525252", "#FFFFFF"] : ["#FFFFFF", "#525252"];
  const shineColor = reverse ? "#171717" : "white";
  const letterColor = reverse ? "#FAFAFA" : "#171717";
  const backRingColor = reverse ? "#D4D4D4" : "#525252";
  const backLineColor = reverse ? "#171717" : "#FAFAFA";

  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true" shapeRendering="geometricPrecision" style={{ overflow: "visible" }} {...props}>
      <g transform="translate(20 20)">
        <g>
          <circle r="16" fill={`url(#${faceId})`} />
          <circle r="15" stroke={`url(#${rimId})`} strokeWidth="2" strokeLinejoin="round" />
          <path d="M-4.5 -7.5H5.5" stroke={shineColor} strokeWidth="2" strokeLinecap="round" opacity="0.55" />
          <text x="0" y="1" textAnchor="middle" dominantBaseline="middle" fill={letterColor} fontSize="18" fontWeight="800" fontFamily="var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif">P</text>
        </g>
      </g>
      <defs>
        <linearGradient id={faceId} x1="8" y1="7" x2="32" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor={faceStops[0]} />
          <stop offset="0.52" stopColor={faceStops[1]} />
          <stop offset="1" stopColor={faceStops[2]} />
        </linearGradient>
        <linearGradient id={backId} x1="8" y1="7" x2="32" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor={backStops[0]} />
          <stop offset="0.5" stopColor={backStops[1]} />
          <stop offset="1" stopColor={backStops[2]} />
        </linearGradient>
        <linearGradient id={rimId} x1="9" y1="6" x2="30" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor={rimStops[0]} />
          <stop offset="1" stopColor={rimStops[1]} />
        </linearGradient>
      </defs>
    </svg>
  );
}
