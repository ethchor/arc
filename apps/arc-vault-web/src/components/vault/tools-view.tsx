"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyField } from "@/components/vault/copy-field";
import { generatePassword } from "@/lib/password";

const PW_LENGTHS = [16, 20, 24, 32];
const RND_LENGTHS = [16, 32, 64];

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export function ToolsView() {
  const [pwLen, setPwLen] = React.useState(20);
  const [pw, setPw] = React.useState(() => generatePassword({ length: 20 }));

  const [rndLen, setRndLen] = React.useState(32);
  const [rnd, setRnd] = React.useState<Uint8Array>(() => crypto.getRandomValues(new Uint8Array(32)));
  const [rndFmt, setRndFmt] = React.useState<"hex" | "base64">("hex");

  const [hashIn, setHashIn] = React.useState("");
  const [hashOut, setHashOut] = React.useState("");

  const regenRnd = (n: number) => {
    setRndLen(n);
    setRnd(crypto.getRandomValues(new Uint8Array(n)));
  };

  React.useEffect(() => {
    if (!hashIn) {
      setHashOut("");
      return;
    }
    let live = true;
    crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(hashIn))
      .then((d) => live && setHashOut(toHex(new Uint8Array(d))));
    return () => {
      live = false;
    };
  }, [hashIn]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Tools</h1>
        <p className="text-sm text-muted-foreground">
          Client-side utilities. Nothing entered here is sent to the server.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Password generator</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {PW_LENGTHS.map((n) => (
                <Button
                  key={n}
                  size="sm"
                  variant={pwLen === n ? "default" : "outline"}
                  onClick={() => {
                    setPwLen(n);
                    setPw(generatePassword({ length: n }));
                  }}
                >
                  {n}
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                aria-label="Regenerate password"
                onClick={() => setPw(generatePassword({ length: pwLen }))}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <CopyField label="Password" value={pw} secret />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Random bytes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {RND_LENGTHS.map((n) => (
                <Button
                  key={n}
                  size="sm"
                  variant={rndLen === n ? "default" : "outline"}
                  onClick={() => regenRnd(n)}
                >
                  {n}B
                </Button>
              ))}
              <Button
                size="sm"
                variant={rndFmt === "hex" ? "secondary" : "ghost"}
                onClick={() => setRndFmt("hex")}
              >
                hex
              </Button>
              <Button
                size="sm"
                variant={rndFmt === "base64" ? "secondary" : "ghost"}
                onClick={() => setRndFmt("base64")}
              >
                base64
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label="Regenerate bytes"
                onClick={() => regenRnd(rndLen)}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <CopyField label="Output" value={rndFmt === "hex" ? toHex(rnd) : toBase64(rnd)} />
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader className="py-3">
            <CardTitle className="text-sm">SHA-256 hash</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="hashin">Input</Label>
              <Input
                id="hashin"
                value={hashIn}
                onChange={(e) => setHashIn(e.target.value)}
                placeholder="Text to hash"
              />
            </div>
            {hashOut && <CopyField label="Digest (hex)" value={hashOut} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
