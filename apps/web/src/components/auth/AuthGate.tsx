import { Show, type JSX } from "solid-js";
import { isAuthenticated } from "~/lib/auth";
import { LoginScreen } from "~/components/auth/LoginScreen";

export function AuthGate(props: { children?: JSX.Element }): JSX.Element {
  return (
    <Show when={isAuthenticated()} fallback={<LoginScreen />}>
      {props.children}
    </Show>
  );
}
