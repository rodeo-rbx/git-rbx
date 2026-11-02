# git-rbx Viewer

Shows `.rbxm` and `.rbxl` files in VS Code (and its forks) as instance trees
with their properties, and shows their diffs the way `git rbx diff` prints
them: a tree of the changed instances, with `-`/`+` lines for each changed
property.

- Clicking an rbxm/rbxl change in Source Control, the Graph, or the Timeline
  opens the diff here instead of the binary placeholder; opening one from
  the Explorer shows the file's tree.
- Instances and properties can be scoped (changed / all, changed /
  non-default / all), searched by name or class, and expanded or collapsed
  all at once. Alt+F5 steps through the changes.
- Content properties preview their assets: Roblox assets through the public
  thumbnails API (cached on disk), `rbxasset://` paths from the local Studio
  install. Class icons also come from the local Studio install.
- With [roblox-headless-renderer](https://github.com/TabooHarmony/roblox-headless-renderer)
  installed (`rhr`), a picture of the file sits over its tree, and a diff
  shows the two versions' pictures side by side: a model framed as an icon
  (a GUI laid out, when there's no 3D to frame), a place as a frame of its
  world. Pictures are previews, not Studio's exact render. Each version is
  drawn once and cached by content; files with nothing to draw (animations)
  say so. Clicking a picture opens it full size.

It runs `git rbx show` and `git rbx diff --format json --with-properties`,
so it needs a git-rbx with those on `PATH`, or set `gitRbx.path`.

## Settings

- `gitRbx.path`: the git-rbx executable.
- `gitRbx.assetPreviews`: preview assets (on by default).
- `gitRbx.renderPreviews`: pictures of the file, when `rhr` is installed (on
  by default).
- `gitRbx.rhrPath`: the `rhr` executable.
- `gitRbx.studioContentPath`: Roblox Studio's `content` folder, when it isn't
  in the default install location.

## Building

```
npx @vscode/vsce package --skip-license
code --install-extension git-rbx-viewer-<version>.vsix
```
