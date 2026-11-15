import { Route, Router } from "@solidjs/router";
import { MetaProvider } from "@solidjs/meta";
import { Suspense, lazy, type JSX } from "solid-js";
import { render } from "solid-js/web";
import "~/styles/main.css";
import { App } from "~/App";
import { AuthGate } from "~/components/auth/AuthGate";
import { WebLayout } from "~/layouts/WebLayout";
import { Routes } from "~/lib/routes";

const AccountsPage = lazy(() => import("~/pages/AccountsPage"));
const ProviderPage = lazy(() => import("~/pages/ProviderPage"));
const ApiKeysPage = lazy(() => import("~/pages/ApiKeysPage"));
const ModelsPage = lazy(() => import("~/pages/ModelsPage"));
const PlaygroundPage = lazy(() => import("~/pages/PlaygroundPage"));
const AuthCallbackPage = lazy(() => import("~/pages/AuthCallbackPage"));
const NotFoundPage = lazy(() => import("~/pages/NotFoundPage"));

function Shell(props: { children?: JSX.Element }): JSX.Element {
  return (
    <AuthGate>
      <WebLayout>
        <Suspense fallback={<div class="min-h-[60vh]" />}>{props.children}</Suspense>
      </WebLayout>
    </AuthGate>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

root.replaceChildren();

render(
  () => (
    <MetaProvider>
      <Router root={App}>
        <Route path="/auth/callback" component={AuthCallbackPage} />
        <Route path="/" component={() => <Shell><AccountsPage /></Shell>} />
        <Route path={Routes.accounts} component={() => <Shell><AccountsPage /></Shell>} />
        <Route path={`${Routes.accounts}/:provider`} component={() => <Shell><ProviderPage /></Shell>} />
        <Route path={Routes.apiKeys} component={() => <Shell><ApiKeysPage /></Shell>} />
        <Route path={Routes.models} component={() => <Shell><ModelsPage /></Shell>} />
        <Route path={Routes.playground} component={() => <Shell><PlaygroundPage /></Shell>} />
        <Route path="*" component={NotFoundPage} />
      </Router>
    </MetaProvider>
  ),
  root
);
