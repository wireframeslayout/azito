import type { IconBuilder } from './grid';
import { rect, clearRect, frame, bottomShade } from './grid';

// 16×16 pixel icon definitions.
// Not downscales of the 24px set: each icon is redrawn for the coarser
// grid with 1px strokes and simplified detail so it stays crisp at
// actual size. Compositions match the 24px counterparts.

export const ICON_BUILDERS_16 = {

// ─── Navigation ───

tasks(g) {
  frame(g, 'ink', 3, 2, 10, 12, 1);
  rect(g, 'mint', 6, 1, 4, 2);
  rect(g, 'mint', 5, 5, 2, 2);  rect(g, 'dim', 8, 5, 3, 2);
  rect(g, 'mint', 5, 9, 2, 2);  rect(g, 'dim', 8, 9, 3, 2);
},

files(g) {
  rect(g, 'ink', 3, 1, 7, 1);
  rect(g, 'ink', 3, 1, 1, 14);
  rect(g, 'ink', 3, 14, 10, 1);
  rect(g, 'ink', 12, 5, 1, 10);
  for (let i = 0; i < 3; i++) rect(g, 'mint', 10 + i, 1 + i, 1, 2);
  rect(g, 'dim', 5, 7, 6, 1);
  rect(g, 'dim', 5, 10, 6, 1);
},

servers(g) {
  frame(g, 'ink', 2, 2, 12, 5, 1);
  rect(g, 'mint', 4, 4, 1, 1);   rect(g, 'dim', 9, 4, 3, 1);
  frame(g, 'ink', 2, 9, 12, 5, 1);
  rect(g, 'amber', 4, 11, 1, 1); rect(g, 'dim', 9, 11, 3, 1);
},

settings(g) {
  rect(g, 'blue', 7, 1, 2, 3);   rect(g, 'blue', 7, 12, 2, 3);
  rect(g, 'blue', 1, 7, 3, 2);   rect(g, 'blue', 12, 7, 3, 2);
  rect(g, 'blue', 3, 3, 2, 2);   rect(g, 'blue', 11, 3, 2, 2);
  rect(g, 'blue', 3, 11, 2, 2);  rect(g, 'blue', 11, 11, 2, 2);
  rect(g, 'blue', 4, 4, 8, 8);
  clearRect(g, 7, 7, 2, 2);
  bottomShade(g, 'blue', 'blueDark', 1);
},

bell(g) {
  rect(g, 'amber', 7, 1, 2, 1);
  rect(g, 'amber', 6, 2, 4, 2);
  rect(g, 'amber', 5, 4, 6, 3);
  rect(g, 'amber', 4, 7, 8, 3);
  rect(g, 'amber', 3, 10, 10, 1);
  rect(g, 'amberDark', 2, 11, 12, 1);
  rect(g, 'amberDark', 7, 13, 2, 1);
  rect(g, 'light', 6, 3, 1, 1);
},

terminal(g) {
  frame(g, 'ink', 1, 2, 14, 11, 1);
  for (let i = 0; i < 3; i++) rect(g, 'mint', 3 + i, 5 + i, 1, 1);
  for (let i = 0; i < 3; i++) rect(g, 'mint', 3 + i, 9 - i, 1, 1);
  rect(g, 'mint', 8, 9, 4, 1);
},

windows(g) {
  frame(g, 'ink', 1, 1, 14, 14, 1);
  rect(g, 'ink', 7, 1, 2, 14);
  rect(g, 'ink', 1, 7, 14, 2);
  rect(g, 'blue', 3, 3, 3, 3);
},

git(g) {
  rect(g, 'dim', 3, 4, 1, 8);
  rect(g, 'dim', 11, 5, 1, 2);
  rect(g, 'dim', 4, 7, 8, 1);
  rect(g, 'mint', 2, 1, 3, 3);
  rect(g, 'mint', 2, 12, 3, 3);
  rect(g, 'blue', 10, 2, 3, 3);
},

storage(g) {
  rect(g, 'amber', 2, 3, 12, 10);
  frame(g, 'amberDark', 2, 3, 12, 10, 1);
  rect(g, 'amberDark', 2, 6, 12, 1);
  rect(g, 'ink', 7, 3, 2, 4);
  bottomShade(g, 'amber', 'amberDark', 1);
},

keyboard(g) {
  frame(g, 'ink', 1, 4, 14, 8, 1);
  for (const x of [3, 5, 9, 11]) rect(g, 'dim', x, 6, 1, 1);
  rect(g, 'mint', 7, 6, 1, 1);
  rect(g, 'dim', 5, 9, 6, 1);
},

projects(g) {
  frame(g, 'dim', 2, 2, 5, 5, 1);
  frame(g, 'dim', 9, 2, 5, 5, 1);
  frame(g, 'dim', 2, 9, 5, 5, 1);
  rect(g, 'mint', 9, 9, 5, 5);
  bottomShade(g, 'mint', 'mintDark', 1);
},

// ─── Domain ───

sidekicks(g) {
  rect(g, 'mint', 7, 1, 2, 1);
  rect(g, 'ink', 7, 2, 2, 1);
  frame(g, 'ink', 4, 3, 8, 6, 1);
  rect(g, 'mint', 6, 5, 1, 1);
  rect(g, 'mint', 9, 5, 1, 1);
  rect(g, 'dim', 7, 7, 2, 1);
  frame(g, 'ink', 5, 9, 6, 5, 1);
  rect(g, 'mint', 7, 11, 2, 1);
  rect(g, 'dim', 3, 10, 1, 3);
  rect(g, 'dim', 12, 10, 1, 3);
},

units(g) {
  frame(g, 'dim', 0, 2, 6, 5, 1);
  rect(g, 'mintDark', 2, 4, 1, 1);
  frame(g, 'dim', 10, 2, 6, 5, 1);
  rect(g, 'mintDark', 13, 4, 1, 1);
  clearRect(g, 4, 0, 8, 15);
  rect(g, 'mint', 7, 1, 2, 1);
  rect(g, 'ink', 7, 2, 2, 1);
  frame(g, 'ink', 5, 3, 6, 5, 1);
  rect(g, 'mint', 6, 5, 1, 1);
  rect(g, 'mint', 9, 5, 1, 1);
  frame(g, 'ink', 5, 8, 6, 5, 1);
  rect(g, 'mint', 7, 10, 2, 1);
  rect(g, 'dim', 3, 9, 1, 3);
  rect(g, 'dim', 12, 9, 1, 3);
},

operations(g) {
  rect(g, 'ink', 5, 1, 6, 1);
  rect(g, 'ink', 5, 14, 6, 1);
  rect(g, 'ink', 1, 5, 1, 6);
  rect(g, 'ink', 14, 5, 1, 6);
  rect(g, 'ink', 3, 2, 2, 1);  rect(g, 'ink', 2, 3, 1, 2);
  rect(g, 'ink', 11, 2, 2, 1); rect(g, 'ink', 13, 3, 1, 2);
  rect(g, 'ink', 2, 11, 1, 2); rect(g, 'ink', 3, 13, 2, 1);
  rect(g, 'ink', 13, 11, 1, 2); rect(g, 'ink', 11, 13, 2, 1);
  rect(g, 'rose', 7, 0, 2, 3);
  rect(g, 'rose', 7, 13, 2, 3);
  rect(g, 'rose', 0, 7, 3, 2);
  rect(g, 'rose', 13, 7, 3, 2);
  rect(g, 'mint', 7, 7, 2, 2);
},

folder(g) {
  rect(g, 'amber', 2, 3, 6, 2);
  rect(g, 'amber', 2, 5, 12, 8);
  frame(g, 'amberDark', 2, 5, 12, 8, 1);
  bottomShade(g, 'amber', 'amberDark', 1);
},

image(g) {
  frame(g, 'ink', 1, 2, 14, 11, 1);
  rect(g, 'amber', 10, 4, 2, 2);
  for (let r = 0; r < 6; r++) {
    const xs = Math.max(2, 5 - r);
    const xe = Math.min(13, 6 + r);
    rect(g, 'mint', xs, 6 + r, xe - xs + 1, 1);
  }
  for (let r = 0; r < 4; r++) {
    const xs = Math.max(2, 10 - r);
    const xe = Math.min(13, 11 + r);
    rect(g, 'mintDark', xs, 8 + r, xe - xs + 1, 1);
  }
},

camera(g) {
  rect(g, 'ink', 5, 3, 4, 2);
  frame(g, 'ink', 1, 5, 14, 9, 1);
  frame(g, 'ink', 5, 7, 6, 5, 1);
  rect(g, 'blue', 7, 8, 2, 2);
  rect(g, 'amber', 12, 6, 1, 1);
},

pin(g) {
  rect(g, 'rose', 5, 2, 6, 3);
  rect(g, 'rose', 6, 5, 4, 3);
  rect(g, 'rose', 4, 8, 8, 2);
  rect(g, 'dim', 7, 10, 2, 4);
},

question(g) {
  rect(g, 'blue', 5, 2, 6, 2);
  rect(g, 'blue', 9, 4, 2, 3);
  rect(g, 'blue', 7, 7, 3, 2);
  rect(g, 'blue', 7, 9, 2, 1);
  rect(g, 'blue', 7, 12, 2, 2);
},

// ─── Actions ───

play(g) {
  for (let i = 0; i < 8; i++) {
    const s = Math.floor(i / 2);
    rect(g, 'mint', 4 + i, 3 + s, 1, 10 - s * 2);
  }
  bottomShade(g, 'mint', 'mintDark', 1);
},

stop(g) {
  rect(g, 'rose', 4, 4, 8, 8);
  bottomShade(g, 'rose', 'roseDark', 1);
  rect(g, 'light', 5, 5, 2, 1);
},

edit(g) {
  for (let i = 0; i < 6; i++) rect(g, 'amber', 9 - i, 3 + i, 2, 2);
  rect(g, 'rose', 9, 3, 2, 2);
  rect(g, 'ink', 8, 4, 2, 2);
  rect(g, 'dim', 3, 10, 1, 1);
  rect(g, 'dim', 2, 11, 1, 1);
},

trash(g) {
  rect(g, 'rose', 6, 1, 4, 1);
  rect(g, 'rose', 3, 2, 10, 2);
  frame(g, 'ink', 4, 5, 8, 9, 1);
  rect(g, 'dim', 6, 7, 1, 4);
  rect(g, 'dim', 9, 7, 1, 4);
},

refresh(g) {
  rect(g, 'blue', 6, 2, 4, 1);
  rect(g, 'blue', 6, 13, 4, 1);
  rect(g, 'blue', 2, 6, 1, 4);
  rect(g, 'blue', 13, 6, 1, 4);
  rect(g, 'blue', 4, 3, 2, 1);  rect(g, 'blue', 3, 4, 1, 2);   // TL
  rect(g, 'blue', 3, 10, 1, 2); rect(g, 'blue', 4, 12, 2, 1);  // BL
  rect(g, 'blue', 12, 10, 1, 2); rect(g, 'blue', 10, 12, 2, 1); // BR
  for (let i = 0; i < 3; i++) rect(g, 'blue', 10 + i, 1 + i, 1, 5 - i * 2);
  bottomShade(g, 'blue', 'blueDark', 1);
},

plus(g) {
  rect(g, 'mint', 7, 3, 2, 10);
  rect(g, 'mint', 3, 7, 10, 2);
  bottomShade(g, 'mint', 'mintDark', 1);
},

close(g) {
  for (let i = 0; i < 10; i++) {
    rect(g, 'rose', 3 + i, 3 + i, 2, 2);
    rect(g, 'rose', 11 - i, 3 + i, 2, 2);
  }
  bottomShade(g, 'rose', 'roseDark', 1);
},

check(g) {
  for (let i = 0; i < 4; i++) rect(g, 'mint', 2 + i, 7 + i, 2, 2);
  for (let i = 0; i < 7; i++) rect(g, 'mint', 5 + i, 10 - i, 2, 2);
  bottomShade(g, 'mint', 'mintDark', 1);
},

warning(g) {
  for (let y = 2; y <= 12; y++) {
    const half = 1 + Math.floor((y - 2) * 5 / 10);
    rect(g, 'amber', 8 - half, y, half * 2, 1);
  }
  rect(g, 'amberDark', 1, 13, 14, 2);
  clearRect(g, 7, 6, 2, 4);
  clearRect(g, 7, 11, 2, 1);
},

extlink(g) {
  frame(g, 'dim', 1, 3, 10, 10, 1);
  clearRect(g, 10, 6, 1, 4);
  rect(g, 'mint', 5, 7, 7, 2);
  rect(g, 'mint', 12, 5, 1, 6);
  rect(g, 'mint', 13, 6, 1, 4);
  rect(g, 'mint', 14, 7, 1, 2);
},

watch(g) {
  rect(g, 'ink', 6, 4, 4, 1);
  rect(g, 'ink', 4, 5, 8, 1);
  rect(g, 'ink', 2, 6, 12, 4);
  rect(g, 'ink', 4, 10, 8, 1);
  rect(g, 'ink', 6, 11, 4, 1);
  clearRect(g, 5, 6, 6, 4);
  clearRect(g, 11, 6, 1, 4);
  rect(g, 'ink', 12, 6, 2, 4);
  rect(g, 'blue', 7, 7, 2, 2);
  rect(g, 'light', 8, 7, 1, 1);
},

// ─── Views ───

listview(g) {
  for (const y of [2, 7, 12]) {
    rect(g, 'mint', 2, y, 2, 2);
    rect(g, 'dim', 6, y, 8, 2);
  }
},

kanban(g) {
  rect(g, 'blue', 2, 2, 3, 5);   rect(g, 'blue', 2, 9, 3, 5);
  rect(g, 'amber', 7, 2, 3, 5);
  rect(g, 'mint', 12, 2, 3, 5);  rect(g, 'mint', 12, 9, 3, 3);
  bottomShade(g, 'blue', 'blueDark', 1);
  bottomShade(g, 'amber', 'amberDark', 1);
  bottomShade(g, 'mint', 'mintDark', 1);
},

pip(g) {
  frame(g, 'ink', 1, 3, 14, 10, 1);
  rect(g, 'mint', 8, 8, 5, 3);
},

menu(g) {
  rect(g, 'ink', 7, 2, 2, 2);
  rect(g, 'ink', 7, 7, 2, 2);
  rect(g, 'ink', 7, 12, 2, 2);
},

chip(g) {
  frame(g, 'ink', 4, 4, 8, 8, 1);
  rect(g, 'mint', 7, 7, 2, 2);
  for (const x of [5, 10]) {
    rect(g, 'dim', x, 2, 1, 2);
    rect(g, 'dim', x, 12, 1, 2);
  }
  for (const y of [5, 10]) {
    rect(g, 'dim', 2, y, 2, 1);
    rect(g, 'dim', 12, y, 2, 1);
  }
},

splitH(g) {
  frame(g, 'ink', 1, 3, 14, 10, 1);
  rect(g, 'mint', 7, 3, 2, 10);
},

splitV(g) {
  frame(g, 'ink', 1, 3, 14, 10, 1);
  rect(g, 'mint', 1, 7, 14, 2);
},

mergePane(g) {
  frame(g, 'ink', 1, 3, 14, 10, 1);
  rect(g, 'dim', 10, 4, 1, 8);
  rect(g, 'mint', 7, 7, 6, 2);
  rect(g, 'mint', 6, 6, 1, 4);
  rect(g, 'mint', 5, 7, 1, 2);
  bottomShade(g, 'mint', 'mintDark', 1);
},

paneNext(g) {
  frame(g, 'ink', 1, 3, 14, 10, 1);
  rect(g, 'dim', 5, 4, 1, 8);
  rect(g, 'mint', 3, 7, 6, 2);
  rect(g, 'mint', 9, 6, 1, 4);
  rect(g, 'mint', 10, 7, 1, 2);
  bottomShade(g, 'mint', 'mintDark', 1);
},

browser(g) {
  frame(g, 'ink', 1, 2, 14, 12, 1);
  rect(g, 'ink', 1, 5, 14, 1);
  rect(g, 'mint', 3, 3, 1, 1);
  rect(g, 'dim', 5, 3, 8, 1);
  rect(g, 'dim', 3, 7, 10, 1);
  rect(g, 'dim', 3, 9, 7, 1);
  rect(g, 'blue', 3, 11, 4, 2);
  bottomShade(g, 'blue', 'blueDark', 1);
},

chevronDown(g) {
  for (let i = 0; i < 4; i++) {
    rect(g, 'ink', 3 + i, 5 + i, 2, 2);
    rect(g, 'ink', 11 - i, 5 + i, 2, 2);
  }
},

paneClose(g) {
  frame(g, 'ink', 1, 3, 14, 10, 1);
  for (let i = 0; i < 5; i++) {
    rect(g, 'rose', 5 + i, 5 + i, 1, 1);
    rect(g, 'rose', 10 - i, 5 + i, 1, 1);
  }
},

palette(g) {
  rect(g, 'ink', 3, 2, 10, 12);
  rect(g, 'ink', 2, 3, 1, 10);
  rect(g, 'ink', 13, 3, 1, 10);
  clearRect(g, 4, 3, 8, 10);
  rect(g, 'rose', 5, 4, 2, 2);
  rect(g, 'amber', 8, 4, 2, 2);
  rect(g, 'mint', 5, 7, 2, 2);
  rect(g, 'blue', 8, 7, 2, 2);
  rect(g, 'dim', 5, 10, 2, 2);
  rect(g, 'rose', 8, 10, 2, 2);
},

} satisfies Record<string, IconBuilder>;
