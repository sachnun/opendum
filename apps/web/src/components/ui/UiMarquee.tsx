import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { cn } from "~/lib/utils";

export interface UiMarqueeProps {
  text: string;
  speed?: number;
  class?: string | string[];
}

export function UiMarquee(props: UiMarqueeProps): JSX.Element {
  let root: HTMLSpanElement | undefined;
  let content: HTMLSpanElement | undefined;
  const [distance, setDistance] = createSignal(0);

  const measure = () => {
    if (!root || !content) return;
    setDistance(Math.max(0, Math.ceil(content.scrollWidth - root.clientWidth)));
  };

  onMount(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (root) observer.observe(root);
    if (content) observer.observe(content);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const text = props.text;
    if (!text) return;
    queueMicrotask(measure);
  });
  const style = () => {
    const size = distance();
    if (size <= 0) return undefined;
    return {
      "--opendum-marquee-distance": `-${size}px`,
      "--opendum-marquee-duration": `${Math.max(4, size / (props.speed ?? 28))}s`,
    } as JSX.CSSProperties;
  };

  return (
    <span ref={root} class={cn("block min-w-0 overflow-hidden", props.class)}>
      <span
        ref={content}
        class={cn("inline-block whitespace-nowrap", distance() > 0 && "opendum-marquee")}
        style={style()}
      >
        {props.text}
      </span>
    </span>
  );
}
