"use client";

import * as React from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generatePassword } from "@/lib/password";

export interface LoginInput {
  title: string;
  url: string;
  username: string;
  password: string;
}

const EMPTY: LoginInput = { title: "", url: "", username: "", password: "" };
const LENGTHS = [16, 20, 24, 32];

export function ItemDialog({
  trigger,
  initial,
  heading = "Add login",
  onSubmit,
}: {
  trigger: React.ReactNode;
  initial?: LoginInput;
  heading?: string;
  onSubmit: (value: LoginInput) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<LoginInput>(initial ?? EMPTY);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) setForm(initial ?? EMPTY);
  }, [open, initial]);

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(form);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof LoginInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>Encrypted on this device before it is saved.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={form.title} onChange={set("title")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="url">URL</Label>
            <Input id="url" placeholder="https://example.com" value={form.url} onChange={set("url")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="username">Username</Label>
            <Input id="username" value={form.username} onChange={set("username")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Password</Label>
            <div className="flex gap-2">
              <Input id="password" className="font-mono" value={form.password} onChange={set("password")} />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Generate password"
                onClick={() => setForm((f) => ({ ...f, password: generatePassword() }))}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" aria-label="Generator length">
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {LENGTHS.map((len) => (
                    <DropdownMenuItem
                      key={len}
                      onClick={() => setForm((f) => ({ ...f, password: generatePassword({ length: len }) }))}
                    >
                      {len} characters
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !form.title}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
