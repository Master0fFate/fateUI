# Third-Party Notices

Fate UI includes third-party software. This file records license notices that must accompany the distribution. Other bundled packages retain their own license files and package metadata.

## OpenUI intelligent answers

Fate UI bundles `@openuidev/react-lang` 1.1.1, `@openuidev/lang-core` 1.1.1 and `@openuidev/observability` 0.0.4 from [OpenUI](https://github.com/thesysdev/openui). Their exact published license files contain the MIT terms below with `Copyright (c) 2011-2024 Thesys Inc.`. The React runtime's development-only inspector dependency is not enabled in production. Fate disables renderer observability publication and the Lang Core installation-telemetry script.

The local component composition, reactive-control patterns, and computation functions in `src/renderer/features/chat/intelligent-ui/` adapt ideas and portions of [open-intelligent-ui at commit 8ecdd17297d1f15cecfbc8750817dda5a576c401](https://github.com/thesysdev/open-intelligent-ui/tree/8ecdd17297d1f15cecfbc8750817dda5a576c401). That source is MIT, `Copyright (c) 2026 Thesys Inc.`. Fate's library is independently themed and deliberately omits that example's arbitrary HTML, raw SVG, remote media, maps, search and service/tool integrations.

Both notices are retained with these complete terms:

```text
The MIT License (MIT)

Copyright (c) 2011-2024 Thesys Inc.
Copyright (c) 2026 Thesys Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Word review

The Word preview uses `saxes` 6.0.0 and `xmlchars` 2.2.0 for XML. `saxes` and its upstream `sax` code carry the ISC License, reproduced below from the [saxes 6.0.0 source](https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE). `xmlchars` carries the MIT License from its published package. The ZIP dependencies `yauzl` 3.4.0 and `pend` 1.2.0 are MIT and retain their license files as installed dependencies.

```text
The ISC License

Copyright (c) Contributors
Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

```text
Copyright Louis-Dominique Dubeau and contributors to xmlchars

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Bundled fonts

Fate UI bundles local Fontsource assets, including Roboto Flex (`@fontsource-variable/roboto-flex` 5.3.0) for the M3 Expressive skin and JetBrains Mono for Angelcore and code. These fonts are distributed under SIL OFL 1.1. Copyright notices and the complete license are included in [FONT_LICENSES.md](FONT_LICENSES.md), which accompanies packaged distributions. No Google brand font or remote font service is required.

## Pi native runtime

Fate UI includes and interoperates with `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/chord`, all pinned to `1.5.0`, from the [Pi repository](https://github.com/earendil-works/pi). Each exact published package declares MIT. The full terms below were verified against [the upstream license at release commit f9a26365568127461c47a07a37dcb42c140a3ac5](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/LICENSE). Fate carries two scoped SDK patches described in [SDK compatibility](docs/sdk-compatibility.md). Pi is distributed under the following MIT License:

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
