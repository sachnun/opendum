import { createUniqueId, type JSX } from "solid-js";

export function PointCoinIcon(props: { reverse?: boolean; class?: string }): JSX.Element {
  const idPrefix = createUniqueId();
  const reverse = () => props.reverse ?? false;

  const faceStops = () => (reverse() ? ["#404040", "#737373", "#FAFAFA"] : ["#FAFAFA", "#A3A3A3", "#404040"]);
  const backStops = () => (reverse() ? ["#262626", "#737373", "#E5E5E5"] : ["#E5E5E5", "#737373", "#262626"]);
  const rimStops = () => (reverse() ? ["#525252", "#FFFFFF"] : ["#FFFFFF", "#525252"]);
  const shineColor = () => (reverse() ? "#171717" : "white");
  const letterColor = () => (reverse() ? "#FAFAFA" : "#171717");
  const backRingColor = () => (reverse() ? "#D4D4D4" : "#525252");
  const backLineColor = () => (reverse() ? "#171717" : "#FAFAFA");

  const faceId = `${idPrefix}-coin-face`;
  const backId = `${idPrefix}-coin-back`;
  const rimId = `${idPrefix}-coin-rim`;

  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      shape-rendering="geometricPrecision"
      text-rendering="geometricPrecision"
      style={{ overflow: "visible" }}
      class={props.class}
    >
      <g transform="translate(20 20)">
        <g>
          <animateTransform
            attributeName="transform"
            type="scale"
            values="1 1;1 1;0.12 1;-1 1;-1 1;-0.12 1;1 1;1 1"
            keyTimes="0;0.68;0.74;0.8;0.86;0.92;0.97;1"
            dur="5s"
            repeatCount="indefinite"
          />
          <g>
            <animate
              attributeName="opacity"
              values="1;1;0;0;0;0;1;1"
              keyTimes="0;0.72;0.74;0.86;0.92;0.94;0.97;1"
              dur="5s"
              repeatCount="indefinite"
            />
            <circle r="16" fill={`url(#${faceId})`} />
            <circle r="15" stroke={`url(#${rimId})`} stroke-width="2" stroke-linejoin="round" />
            <path d="M-4.5 -7.5H5.5" stroke={shineColor()} stroke-width="2" stroke-linecap="round" opacity="0.55" />
            <text
              x="0"
              y="1"
              text-anchor="middle"
              dominant-baseline="middle"
              fill={letterColor()}
              font-size="18"
              font-weight="800"
              font-family="var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
            >
              P
            </text>
          </g>
          <g opacity="0">
            <animate
              attributeName="opacity"
              values="0;0;1;1;1;1;0;0"
              keyTimes="0;0.72;0.74;0.86;0.92;0.94;0.97;1"
              dur="5s"
              repeatCount="indefinite"
            />
            <circle r="16" fill={`url(#${backId})`} />
            <circle r="15" stroke={`url(#${rimId})`} stroke-width="2" stroke-linejoin="round" />
            <circle r="8" stroke={backRingColor()} stroke-width="2" opacity="0.55" />
            <path d="M-7 0H7" stroke={backLineColor()} stroke-width="1.8" stroke-linecap="round" opacity="0.45" />
          </g>
        </g>
      </g>
      <defs>
        <linearGradient id={faceId} x1="8" y1="7" x2="32" y2="34" gradientUnits="userSpaceOnUse">
          <stop stop-color={faceStops()[0]} />
          <stop offset="0.52" stop-color={faceStops()[1]} />
          <stop offset="1" stop-color={faceStops()[2]} />
        </linearGradient>
        <linearGradient id={backId} x1="8" y1="7" x2="32" y2="34" gradientUnits="userSpaceOnUse">
          <stop stop-color={backStops()[0]} />
          <stop offset="0.5" stop-color={backStops()[1]} />
          <stop offset="1" stop-color={backStops()[2]} />
        </linearGradient>
        <linearGradient id={rimId} x1="9" y1="6" x2="30" y2="34" gradientUnits="userSpaceOnUse">
          <stop stop-color={rimStops()[0]} />
          <stop offset="1" stop-color={rimStops()[1]} />
        </linearGradient>
      </defs>
    </svg>
  );
}
