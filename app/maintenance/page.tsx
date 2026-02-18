import { Wrench } from "lucide-react";

export default function MaintenancePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="mx-auto max-w-md px-4 text-center">
        <Wrench className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="mt-6 text-3xl font-bold tracking-tighter sm:text-4xl">
          Under Maintenance
        </h1>
        <p className="mt-4 font-mono text-sm text-muted-foreground">
          We&apos;re performing scheduled maintenance. The service will be back
          shortly.
        </p>
      </div>
    </div>
  );
}
