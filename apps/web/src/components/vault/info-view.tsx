"use client";

import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function InfoView({
  icon: Icon,
  title,
  description,
  points,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  points: string[];
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Card>
        <CardContent className="space-y-3 py-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Icon className="h-5 w-5" />
            <span className="text-sm font-medium">What this surface shows</span>
          </div>
          <ul className="ml-7 list-disc space-y-1 text-sm text-muted-foreground">
            {points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
