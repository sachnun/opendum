import { onMount, type JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { parentRoute } from "~/lib/routes";

export function NotFoundPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  onMount(() => {
    const path = window.location.pathname;
    const parent = parentRoute(path);
    if (parent !== path) {
      navigate(parent, { replace: true });
      return;
    }

    const query = new URLSearchParams(searchParams as Record<string, string>).toString();
    navigate(query ? `/?${query}` : "/", { replace: true });
  });

  return <div />;
}

export default NotFoundPage;
