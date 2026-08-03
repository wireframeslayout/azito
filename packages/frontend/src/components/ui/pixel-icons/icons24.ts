import type { IconBuilder } from './grid';
import { rect, clearRect, frame, bottomShade } from './grid';

// 24×24 pixel icon definitions.
// Canvas: 24×24, ~2px padding, 2px stroke weight, depth-2 bottom shading.

export const ICON_BUILDERS_24 = {

// ─── Navigation ───

tasks(g) {            // clipboard with checklist
  frame(g, 'ink', 4, 4, 16, 17, 2);
  rect(g, 'mint', 8, 2, 8, 4);                        // clip tab
  rect(g, 'mint', 7, 9, 3, 3);  rect(g, 'dim', 12, 9, 5, 3);
  rect(g, 'mint', 7, 14, 3, 3); rect(g, 'dim', 12, 14, 5, 3);
},

files(g) {            // document with folded corner
  rect(g, 'ink', 5, 3, 10, 2);
  rect(g, 'ink', 5, 3, 2, 18);
  rect(g, 'ink', 5, 19, 14, 2);
  rect(g, 'ink', 17, 7, 2, 14);
  for (let i = 0; i < 4; i++) rect(g, 'mint', 14 + i, 3 + i, 2, 2);  // fold
  rect(g, 'dim', 8, 10, 8, 2);
  rect(g, 'dim', 8, 14, 8, 2);
},

servers(g) {          // two rack units: LED + vent
  frame(g, 'ink', 3, 3, 18, 8, 2);
  rect(g, 'mint', 6, 6, 2, 2);   rect(g, 'dim', 12, 6, 6, 2);
  frame(g, 'ink', 3, 13, 18, 8, 2);
  rect(g, 'amber', 6, 16, 2, 2); rect(g, 'dim', 12, 16, 6, 2);
},

settings(g) {         // 8-tooth gear
  rect(g, 'blue', 10, 3, 4, 4);  rect(g, 'blue', 10, 17, 4, 4);
  rect(g, 'blue', 3, 10, 4, 4);  rect(g, 'blue', 17, 10, 4, 4);
  rect(g, 'blue', 5, 5, 4, 4);   rect(g, 'blue', 15, 5, 4, 4);
  rect(g, 'blue', 5, 15, 4, 4);  rect(g, 'blue', 15, 15, 4, 4);
  rect(g, 'blue', 6, 6, 12, 12);
  clearRect(g, 10, 10, 4, 4);                         // axle hole
  bottomShade(g, 'blue', 'blueDark', 2);
  rect(g, 'light', 11, 4, 2, 1);                      // top highlight
},

bell(g) {             // bell with shaded skirt
  rect(g, 'amber', 10, 3, 4, 2);
  rect(g, 'amber', 8, 5, 8, 2);
  rect(g, 'amber', 7, 7, 10, 4);
  rect(g, 'amber', 6, 11, 12, 3);
  rect(g, 'amber', 5, 14, 14, 1);
  rect(g, 'amberDark', 3, 15, 18, 2);                 // skirt
  rect(g, 'amberDark', 10, 18, 4, 2);                 // clapper
  rect(g, 'light', 9, 6, 2, 1);                       // sheen
  rect(g, 'light', 8, 8, 1, 2);
},

terminal(g) {         // window + prompt chevron + cursor
  frame(g, 'ink', 2, 4, 20, 16, 2);
  for (let i = 0; i < 4; i++) rect(g, 'mint', 5 + i, 8 + i, 2, 2);
  for (let i = 0; i < 4; i++) rect(g, 'mint', 5 + i, 14 - i, 2, 2);
  rect(g, 'mint', 12, 14, 6, 2);                      // cursor
},

windows(g) {          // 4-pane window, one pane active
  frame(g, 'ink', 3, 3, 18, 18, 2);
  rect(g, 'ink', 11, 3, 2, 18);
  rect(g, 'ink', 3, 11, 18, 2);
  rect(g, 'blue', 5, 5, 6, 6);                        // active pane
},

git(g) {              // branch graph
  rect(g, 'dim', 6, 7, 2, 10);                        // trunk
  rect(g, 'dim', 16, 8, 2, 4);                        // branch drop
  rect(g, 'dim', 8, 11, 8, 2);                        // elbow
  rect(g, 'mint', 5, 3, 4, 4);                        // top node
  rect(g, 'mint', 5, 17, 4, 4);                       // bottom node
  rect(g, 'blue', 15, 4, 4, 4);                       // branch node
},

storage(g) {          // package box with tape
  rect(g, 'amber', 3, 5, 18, 15);
  frame(g, 'amberDark', 3, 5, 18, 15, 1);
  rect(g, 'amberDark', 3, 9, 18, 2);                  // lid seam
  rect(g, 'ink', 11, 5, 2, 6);                        // tape
  bottomShade(g, 'amber', 'amberDark', 2);
},

keyboard(g) {
  frame(g, 'ink', 2, 6, 20, 12, 2);
  for (const x of [5, 8, 14, 17]) rect(g, 'dim', x, 9, 2, 2);
  rect(g, 'mint', 11, 9, 2, 2);                       // pressed key
  rect(g, 'dim', 7, 13, 10, 2);                       // spacebar
},

projects(g) {         // 2×2 grid, one tile active
  frame(g, 'dim', 3, 3, 8, 8, 2);
  frame(g, 'dim', 13, 3, 8, 8, 2);
  frame(g, 'dim', 3, 13, 8, 8, 2);
  rect(g, 'mint', 13, 13, 8, 8);
  bottomShade(g, 'mint', 'mintDark', 2);
},

// ─── Domain ───

sidekicks(g) {        // companion robot sprite
  rect(g, 'mint', 10, 1, 4, 2);                       // antenna tip
  rect(g, 'ink', 11, 3, 2, 2);                        // antenna stem
  frame(g, 'ink', 6, 5, 12, 9, 2);                    // head
  rect(g, 'mint', 9, 8, 2, 2);                        // eyes
  rect(g, 'mint', 13, 8, 2, 2);
  rect(g, 'dim', 10, 11, 4, 1);                       // mouth
  frame(g, 'ink', 8, 14, 8, 6, 2);                    // body
  rect(g, 'mint', 11, 16, 2, 2);                      // core
  rect(g, 'dim', 4, 15, 2, 4);                        // arms
  rect(g, 'dim', 18, 15, 2, 4);
},

units(g) {            // sidekick squad: two behind, leader in front
  frame(g, 'dim', 1, 3, 9, 8, 2);                     // back-left head
  rect(g, 'mintDark', 4, 6, 2, 2);
  frame(g, 'dim', 14, 3, 9, 8, 2);                    // back-right head
  rect(g, 'mintDark', 19, 6, 2, 2);
  clearRect(g, 6, 2, 12, 20);                         // leader silhouette
  rect(g, 'mint', 10, 2, 4, 2);                       // antenna tip
  rect(g, 'ink', 11, 4, 2, 2);                        // antenna stem
  frame(g, 'ink', 7, 6, 10, 8, 2);                    // head
  rect(g, 'mint', 9, 9, 2, 2);                        // eyes
  rect(g, 'mint', 13, 9, 2, 2);
  frame(g, 'ink', 8, 14, 8, 6, 2);                    // body
  rect(g, 'mint', 11, 16, 2, 2);                      // core
  rect(g, 'dim', 5, 15, 2, 4);                        // arms
  rect(g, 'dim', 17, 15, 2, 4);
},

operations(g) {       // target reticle
  rect(g, 'ink', 8, 3, 8, 2);
  rect(g, 'ink', 8, 19, 8, 2);
  rect(g, 'ink', 3, 8, 2, 8);
  rect(g, 'ink', 19, 8, 2, 8);
  rect(g, 'ink', 6, 4, 2, 2);   rect(g, 'ink', 4, 6, 2, 2);
  rect(g, 'ink', 16, 4, 2, 2);  rect(g, 'ink', 18, 6, 2, 2);
  rect(g, 'ink', 4, 16, 2, 2);  rect(g, 'ink', 6, 18, 2, 2);
  rect(g, 'ink', 18, 16, 2, 2); rect(g, 'ink', 16, 18, 2, 2);
  rect(g, 'rose', 11, 1, 2, 5);                       // crosshair ticks
  rect(g, 'rose', 11, 18, 2, 5);
  rect(g, 'rose', 1, 11, 5, 2);
  rect(g, 'rose', 18, 11, 5, 2);
  rect(g, 'mint', 10, 10, 4, 4);                      // lock-on core
},

folder(g) {           // folder with tab
  rect(g, 'amber', 3, 4, 8, 3);                       // tab
  frame(g, 'amberDark', 3, 4, 8, 3, 1);
  rect(g, 'amber', 3, 7, 18, 13);                     // body
  frame(g, 'amberDark', 3, 7, 18, 13, 1);
  bottomShade(g, 'amber', 'amberDark', 2);
},

image(g) {            // picture: sun + layered mountains
  frame(g, 'ink', 3, 4, 18, 16, 2);
  rect(g, 'amber', 15, 7, 3, 3);                      // sun
  for (let r = 0; r < 7; r++) {                       // back mountain
    const xs = Math.max(5, 9 - r);
    const xe = Math.min(18, 10 + r);
    rect(g, 'mint', xs, 11 + r, xe - xs + 1, 1);
  }
  for (let r = 0; r < 5; r++) {                       // front mountain
    const xs = Math.max(5, 15 - r);
    const xe = Math.min(18, 16 + r);
    rect(g, 'mintDark', xs, 13 + r, xe - xs + 1, 1);
  }
},

camera(g) {           // camera with lens + flash
  rect(g, 'ink', 8, 4, 6, 3);                         // viewfinder bump
  frame(g, 'ink', 3, 7, 18, 13, 2);                   // body
  frame(g, 'ink', 8, 9, 8, 8, 2);                     // lens ring
  rect(g, 'blue', 10, 11, 4, 4);                      // lens glass
  rect(g, 'amber', 17, 9, 2, 2);                      // flash
},

pin(g) {              // pushpin
  rect(g, 'rose', 8, 3, 8, 4);                        // cap
  rect(g, 'rose', 9, 7, 6, 5);                        // body
  rect(g, 'rose', 6, 12, 12, 2);                      // flange
  rect(g, 'dim', 11, 14, 2, 6);                       // needle
  bottomShade(g, 'rose', 'roseDark', 1);
},

question(g) {         // question mark
  rect(g, 'blue', 8, 4, 8, 3);                        // top
  rect(g, 'blue', 13, 7, 3, 4);                       // right
  rect(g, 'blue', 10, 11, 4, 3);                      // bend
  rect(g, 'blue', 10, 14, 3, 2);                      // stem
  rect(g, 'blue', 10, 18, 3, 3);                      // dot
},

// ─── Actions ───

play(g) {
  for (let i = 0; i < 12; i++) {
    const s = Math.floor(i / 2);
    rect(g, 'mint', 6 + i, 5 + s, 1, 14 - s * 2);
  }
  bottomShade(g, 'mint', 'mintDark', 2);
},

stop(g) {
  rect(g, 'rose', 6, 6, 12, 12);
  bottomShade(g, 'rose', 'roseDark', 2);
  rect(g, 'light', 7, 7, 3, 1);
  rect(g, 'light', 7, 8, 1, 2);
},

edit(g) {             // 45° pencil: eraser, ferrule, shaft, tip
  for (let i = 0; i < 10; i++) rect(g, 'amber', 14 - i, 4 + i, 3, 3);
  rect(g, 'rose', 14, 4, 3, 3);                       // eraser
  rect(g, 'rose', 15, 4, 3, 2);
  rect(g, 'ink', 13, 5, 3, 3);                        // ferrule
  rect(g, 'dim', 4, 16, 2, 2);                        // tip
  rect(g, 'dim', 3, 18, 1, 1);
},

trash(g) {
  rect(g, 'rose', 9, 2, 6, 2);                        // handle
  rect(g, 'rose', 4, 4, 16, 2);                       // lid
  frame(g, 'ink', 6, 7, 12, 13, 2);                   // body
  rect(g, 'dim', 9, 10, 2, 7);                        // slots
  rect(g, 'dim', 13, 10, 2, 7);
},

refresh(g) {          // octagonal arc + clockwise arrowhead
  rect(g, 'blue', 8, 3, 8, 2);
  rect(g, 'blue', 8, 19, 8, 2);
  rect(g, 'blue', 3, 8, 2, 8);
  rect(g, 'blue', 19, 8, 2, 8);
  rect(g, 'blue', 6, 4, 2, 2);   rect(g, 'blue', 4, 6, 2, 2);
  rect(g, 'blue', 16, 4, 2, 2);  rect(g, 'blue', 18, 6, 2, 2);
  rect(g, 'blue', 4, 16, 2, 2);  rect(g, 'blue', 6, 18, 2, 2);
  rect(g, 'blue', 18, 16, 2, 2); rect(g, 'blue', 16, 18, 2, 2);
  clearRect(g, 13, 2, 9, 7);
  for (let i = 0; i < 4; i++) rect(g, 'blue', 13 + i, 2 + i, 1, 7 - i * 2);
  bottomShade(g, 'blue', 'blueDark', 2);
},

plus(g) {
  rect(g, 'mint', 10, 4, 4, 16);
  rect(g, 'mint', 4, 10, 16, 4);
  bottomShade(g, 'mint', 'mintDark', 2);
},

close(g) {
  for (let i = 0; i < 12; i++) {
    rect(g, 'rose', 5 + i, 5 + i, 3, 3);
    rect(g, 'rose', 16 - i, 5 + i, 3, 3);
  }
  bottomShade(g, 'rose', 'roseDark', 2);
},

check(g) {
  for (let i = 0; i < 5; i++)  rect(g, 'mint', 4 + i, 10 + i, 3, 3);
  for (let i = 0; i < 10; i++) rect(g, 'mint', 8 + i, 14 - i, 3, 3);
  bottomShade(g, 'mint', 'mintDark', 2);
},

warning(g) {          // triangle with exclamation cutout
  for (let y = 4; y <= 18; y++) {
    const half = 1 + Math.floor((y - 4) * 8 / 14);
    rect(g, 'amber', 12 - half, y, half * 2, 1);
  }
  rect(g, 'amberDark', 2, 19, 20, 2);                 // base
  clearRect(g, 11, 9, 2, 6);                          // ! bar
  clearRect(g, 11, 17, 2, 2);                         // ! dot
},

extlink(g) {          // box + horizontal arrow out of the right edge
  frame(g, 'dim', 2, 4, 15, 16, 2);
  clearRect(g, 15, 8, 2, 8);
  rect(g, 'mint', 7, 10, 11, 4);
  rect(g, 'mint', 18, 7, 1, 10);
  rect(g, 'mint', 19, 8, 1, 8);
  rect(g, 'mint', 20, 9, 1, 6);
  rect(g, 'mint', 21, 10, 1, 4);
  rect(g, 'mint', 22, 11, 1, 2);
},

watch(g) {            // eye
  rect(g, 'ink', 9, 7, 6, 1);
  rect(g, 'ink', 7, 8, 10, 1);
  rect(g, 'ink', 5, 9, 14, 1);
  rect(g, 'ink', 3, 10, 18, 4);
  rect(g, 'ink', 5, 14, 14, 1);
  rect(g, 'ink', 7, 15, 10, 1);
  rect(g, 'ink', 9, 16, 6, 1);
  clearRect(g, 8, 9, 8, 1);
  clearRect(g, 6, 10, 12, 4);
  clearRect(g, 8, 14, 8, 1);
  rect(g, 'blue', 10, 10, 4, 4);                      // iris
  rect(g, 'light', 12, 10, 1, 1);                     // catchlight
},

// ─── Views ───

listview(g) {
  for (const y of [4, 10, 16]) {
    rect(g, 'mint', 4, y, 3, 3);
    rect(g, 'dim', 9, y, 11, 3);
  }
},

kanban(g) {           // columns colored by status
  rect(g, 'blue', 3, 3, 5, 8);    rect(g, 'blue', 3, 13, 5, 8);
  rect(g, 'amber', 10, 3, 5, 8);
  rect(g, 'mint', 17, 3, 5, 8);   rect(g, 'mint', 17, 13, 5, 5);
  bottomShade(g, 'blue', 'blueDark', 1);
  bottomShade(g, 'amber', 'amberDark', 1);
  bottomShade(g, 'mint', 'mintDark', 1);
},

pip(g) {
  frame(g, 'ink', 2, 4, 20, 16, 2);
  rect(g, 'mint', 12, 12, 7, 5);
},

menu(g) {
  rect(g, 'ink', 10, 3, 4, 4);
  rect(g, 'ink', 10, 10, 4, 4);
  rect(g, 'ink', 10, 17, 4, 4);
},

chip(g) {             // AI / LLM chip with glowing core
  frame(g, 'ink', 6, 6, 12, 12, 2);
  rect(g, 'mint', 10, 10, 4, 4);
  for (const x of [8, 11, 14]) {
    rect(g, 'dim', x, 3, 2, 3);
    rect(g, 'dim', x, 18, 2, 3);
  }
  for (const y of [8, 11, 14]) {
    rect(g, 'dim', 3, y, 3, 2);
    rect(g, 'dim', 18, y, 3, 2);
  }
},

splitH(g) {
  frame(g, 'ink', 2, 4, 20, 16, 2);
  rect(g, 'mint', 11, 4, 2, 16);
},

splitV(g) {
  frame(g, 'ink', 2, 4, 20, 16, 2);
  rect(g, 'mint', 2, 11, 20, 2);
},

mergePane(g) {        // pane frame + divider crossed by a leftward arrow (fold right pane into left)
  frame(g, 'ink', 2, 4, 20, 16, 2);
  rect(g, 'dim', 16, 6, 2, 12);
  rect(g, 'mint', 13, 10, 7, 4);
  rect(g, 'mint', 12, 7, 1, 10);
  rect(g, 'mint', 11, 8, 1, 8);
  rect(g, 'mint', 10, 9, 1, 6);
  rect(g, 'mint', 9, 10, 1, 4);
  rect(g, 'mint', 8, 11, 1, 2);
  bottomShade(g, 'mint', 'mintDark', 2);
},

paneNext(g) {          // mirror of mergePane: rightward arrow toward the next pane
  frame(g, 'ink', 2, 4, 20, 16, 2);
  rect(g, 'dim', 6, 6, 2, 12);
  rect(g, 'mint', 4, 10, 7, 4);
  rect(g, 'mint', 11, 7, 1, 10);
  rect(g, 'mint', 12, 8, 1, 8);
  rect(g, 'mint', 13, 9, 1, 6);
  rect(g, 'mint', 14, 10, 1, 4);
  rect(g, 'mint', 15, 11, 1, 2);
  bottomShade(g, 'mint', 'mintDark', 2);
},

browser(g) {           // browser window: dot + url bar, toolbar separator, content lines, button
  frame(g, 'ink', 2, 3, 20, 18, 2);
  rect(g, 'ink', 2, 9, 20, 2);
  rect(g, 'mint', 5, 5, 2, 2);
  rect(g, 'dim', 9, 5, 11, 2);
  rect(g, 'dim', 5, 12, 15, 2);
  rect(g, 'dim', 5, 15, 11, 2);
  rect(g, 'blue', 5, 17, 6, 2);
  bottomShade(g, 'blue', 'blueDark', 1);
},

chevronDown(g) {
  for (let i = 0; i < 7; i++) {
    rect(g, 'ink', 5 + i, 7 + i, 2, 2);
    rect(g, 'ink', 17 - i, 7 + i, 2, 2);
  }
},

paneClose(g) {         // pane frame + small centered X
  frame(g, 'ink', 2, 4, 20, 16, 2);
  for (let i = 0; i < 6; i++) {
    rect(g, 'rose', 9 + i, 9 + i, 2, 2);
    rect(g, 'rose', 13 - i, 9 + i, 2, 2);
  }
},

palette(g) {
  frame(g, 'ink', 3, 2, 18, 20, 2);
  clearRect(g, 5, 4, 14, 16);
  rect(g, 'rose', 6, 5, 3, 3);
  rect(g, 'amber', 11, 5, 3, 3);
  rect(g, 'mint', 6, 10, 3, 3);
  rect(g, 'blue', 11, 10, 3, 3);
  rect(g, 'dim', 6, 15, 3, 3);
  rect(g, 'ink', 11, 15, 3, 3);
},

} satisfies Record<string, IconBuilder>;
