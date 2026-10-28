# Third-Party Notices

Fate UI includes third-party software. This file records license notices that must accompany the distribution. Other bundled packages retain their own license files and package metadata.

## Bundled fonts

Fate UI bundles local Fontsource assets, including Roboto Flex (`@fontsource-variable/roboto-flex` 5.3.0) for the M3 Expressive skin and JetBrains Mono for Angelcore and code. These fonts are distributed under SIL OFL 1.1. Copyright notices and the complete license are included in [FONT_LICENSES.md](FONT_LICENSES.md), which accompanies packaged distributions. No Google brand font or remote font service is required.

## Pi native runtime

Fate UI includes and interoperates with `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/chord`, all pinned to `1.4.0`, from the [Pi repository](https://github.com/earendil-works/pi). Each exact published package declares MIT. The full terms below were verified against [the upstream license at release commit 4a080252f06caf63a525d7873c5d94d3c23887e0](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/LICENSE). Fate carries two scoped SDK patches described in [SDK compatibility](docs/sdk-compatibility.md). Pi is distributed under the following MIT License:

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fixed-viewport scroll isolation

Fate retains `react-remove-scroll@2.7.2` for wheel, touch, nested-lock, shard and pinch-zoom event isolation. Its exact published archive contains the MIT terms below. The Fate-specific patch omits only body scrollbar mutation because both renderer entries already use a permanently non-scrolling viewport. The scoped dependency override removes `react-remove-scroll-bar` from the resolved graph; it does not invent or establish license terms for that former dependency. See [the fixed-viewport compatibility contract](docs/v2/fixed-viewport-scroll.md).

`@radix-ui/react-popover@1.1.23` supplies the compatible FocusScope API already used by Dialog and Select. Its complete published MIT license, with the 2022 WorkOS notice, remains in the installed package and generated browser notices. A forced override of the older Popover's internal FocusScope is not used.

Exact retained `react-remove-scroll@2.7.2` terms, from [its official published archive](https://registry.npmjs.org/react-remove-scroll/-/react-remove-scroll-2.7.2.tgz):

```text
MIT License

Copyright (c) 2017 Anton Korzunov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## PDF tools

The `pdf_read`, `pdf_fill` and `pdf_create` tools bundle these packages into the main-process and server builds, so their license files do not ship separately. Exact versions are pinned in `package.json` and `pnpm-lock.yaml`.

- `pdf-lib` 1.17.1, MIT. Copyright (c) 2019 Andrew Dillon.
- `@pdf-lib/standard-fonts` 1.0.0, MIT. Copyright (c) 2018 Andrew Dillon.
- `@pdf-lib/upng` 1.0.1, MIT. Copyright (c) 2017 Photopea.
- `pako` 1.0.11, MIT AND Zlib. Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn.
- `tslib` 1.14.1, 0BSD. Copyright (c) Microsoft Corporation.
- `unpdf` 1.8.1, MIT. Copyright (c) 2023-PRESENT Johann Schopplich.
- PDF.js 6.1.200, Apache-2.0. Copyright 2012 Mozilla Foundation. It is the unmodified serverless build published inside `unpdf` 1.8.1. The complete Apache License 2.0 text is in [LICENSE](LICENSE).

Each MIT package above is distributed with its copyright line above and these terms:

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
