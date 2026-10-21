# Third-party notices

OpenOrch is an independent project. It is not affiliated with, endorsed by, or
sponsored by the OpenCode team or any other project mentioned in this repository.

## OpenCode

Some built-in agent prompts, agent descriptions, and tool text are derived from
the OpenCode project:

- https://github.com/anomalyco/opencode
- Copyright (c) 2025 opencode
- MIT License

The generated prompt file (`packages/core/src/agents/prompts.generated.ts`) and
the built-in agent definitions in `packages/core/src/agents/index.ts` retain the
upstream MIT notice.

The MIT license text for that material is reproduced below:

```text
MIT License

Copyright (c) 2025 opencode

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

## models.dev catalog

The embedded model catalog in
`packages/core/src/providers/catalog.json` was generated from a models.dev
snapshot distributed through the OpenCode project. See:

- https://models.dev
- https://github.com/anomalyco/opencode

The catalog is data, not executable code. Provider names, model names, prices,
and capabilities remain the property of their respective owners.

## Other dependencies

OpenOrch uses third-party open-source packages managed by Bun. Their licenses
remain in their own packages and lockfile metadata; they are not relicensed by
this project. When distributing a compiled application, include the license
notices required by the bundled dependencies.

The README structure and presentation were inspired by public README files from
OpenCode, Open Design, and DeepSeek Harness. No source code from Open Design or
DeepSeek Harness is included in this repository.
