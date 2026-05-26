"use client";

import * as React from "react";
import { LogIn, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  phase: "login" | "account";
  busy: boolean;
  onSignIn: (baseUrl: string, email: string) => void;
  onUnlock: (password: string) => void;
  onEnroll: (password: string) => void;
  onNewDevice?: () => void;
}

export function UnlockScreen({ phase, busy, onSignIn, onUnlock, onEnroll, onNewDevice }: Props) {
  const [baseUrl, setBaseUrl] = React.useState("http://localhost:3001");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <ShieldCheck className="h-5 w-5 text-primary" />
          </div>
          <CardTitle className="text-xl">
            {phase === "login" ? "Sign in" : "Unlock your vault"}
          </CardTitle>
          <CardDescription>
            {phase === "login"
              ? "Sign-in authorizes sync only — it does not unlock the vault."
              : "Your master password is processed on this device and never sent."}
          </CardDescription>
        </CardHeader>

        {phase === "login" ? (
          <>
            <CardContent className="space-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor="baseUrl">API base URL</Label>
                <Input id="baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button className="w-full" disabled={busy || !email} onClick={() => onSignIn(baseUrl, email)}>
                <LogIn className="h-4 w-4" /> Continue
              </Button>
            </CardFooter>
          </>
        ) : (
          <>
            <CardContent className="space-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor="password">Master password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && password) onUnlock(password);
                  }}
                />
              </div>
            </CardContent>
            <CardFooter className="flex-col gap-2">
              <Button className="w-full" disabled={busy || !password} onClick={() => onUnlock(password)}>
                Unlock
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                disabled={busy || !password}
                onClick={() => onEnroll(password)}
              >
                Create a new vault
              </Button>
              {onNewDevice && (
                <Button variant="ghost" className="w-full" disabled={busy} onClick={onNewDevice}>
                  Set up as a new device
                </Button>
              )}
            </CardFooter>
          </>
        )}
      </Card>
    </div>
  );
}
