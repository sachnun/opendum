import { Title } from "@solidjs/meta";
import type { RouteSectionProps } from "@solidjs/router";

export function App(props: RouteSectionProps) {
  return (
    <>
      <Title>Opendum</Title>
      {props.children}
    </>
  );
}
