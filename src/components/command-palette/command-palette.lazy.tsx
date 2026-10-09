"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

import { useCommandPaletteOpen } from "./palette-store";

const CommandPalette = dynamic(() => import("./command-palette"), {
  ssr: false,
});

/**
 * Mounted once by the signed-in shell. The palette's own chunk loads the
 * first time it opens (or when the pointer reaches the top-bar button), and
 * stays mounted afterwards so a second open is instant.
 */
export function CommandPaletteMount() {
  const open = useCommandPaletteOpen();
  const [wanted, setWanted] = useState(false);
  if (open && !wanted) setWanted(true);
  return wanted ? <CommandPalette /> : null;
}
