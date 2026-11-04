# README screenshots

`make.sh` regenerates the screenshots in [`docs/images`](../images) that the
[README](../../README.md#what-it-looks-like) shows:

```sh
mise run screenshots        # or docs/screenshots/make.sh
```

It builds this checkout's git-rbx, makes a scratch repository of example
models (`examples.luau`: a town whose house and trees move, and a campfire
whose flames change color), and screenshots:

- the editor viewer (`viewer.js`): the extension's own `extension.js` runs
  against a stubbed `vscode`, and its webview is shown in a headless browser
  with VS Code's Dark Modern theme;
- `git diff` and `git log -p` (`terminal.js`), with their colors.

It needs, on `PATH`:

- [Lune](https://lune-org.github.io/docs), Node, and Cargo;
- [roblox-headless-renderer](https://github.com/TabooHarmony/roblox-headless-renderer)
  (`uv tool install roblox-headless-renderer`), for the pictures. It downloads
  textures with the Studio login;
- Chrome or Edge. `SCREENSHOT_BROWSER` picks one by its Playwright channel
  (`chrome`, `msedge`);
- optionally [oxipng](https://github.com/shssoichiro/oxipng), which shrinks
  the PNGs.

`RHR` and `OXIPNG` name those two executables when `PATH`'s copies don't run.
Under `mise run`, for example, a mise shim with no version set comes first.

The class icons come from a local Roblox Studio install, as they do in the
extension.

When the examples change, update the counts the README quotes: `make.sh`
prints the line diff's.
