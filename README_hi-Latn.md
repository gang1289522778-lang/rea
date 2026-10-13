<div align="center">

[English](README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · **Hinglish**

# REA: Reverse Engineer Anything

### Ek hi MCP se binaries, applications aur runtime behavior ki reverse engineering.

**Koi feature pasand aaya? Samjhiye ki woh kaise kaam karta hai, binary level tak.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#current-status)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[Website](https://rea.tools/) · [Guides](https://rea.tools/guides/) · [Showcases](https://rea.tools/showcase/)**

[Quick start](#quick-start) · [REA kaise kaam karta hai](#rea-kaise-kaam-karta-hai) · [Aap kya analyze kar sakte hain](#aap-kya-analyze-kar-sakte-hain) · [Showcases](#showcases) · [FAQ](#faq) · [Documentation](#documentation)

<code>npx rea-agents setup</code>

<br />

<img src="docs/assets/rea-hopper-analysis.png" alt="REA ek native binary inspect karte hue Hopper ke andar apna analysis bridge launch kar raha hai" width="1200" />

<br /><br />

<table aria-label="REA community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="docs/assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Reverse Engineering Community join karein</strong>
  </a><br />
  <sub>Discord · Q&amp;A · Show and Tell</sub>
</td>
</tr>
</table>

<br />

</div>

---

Kisi app mein aisa feature dikha jo aap apne product mein chahte hain? Apne agent se kahiye ki woh REA ke saath uski jaanch kare. Agent bina source code ke app ko inspect kar sakta hai, samjha sakta hai ki feature kaise kaam karta hai, evidence dikha sakta hai, aur aapke project ke liye uska ek version bana sakta hai.

REA aapke agent ko un tools se jodta hai jo native binaries, JavaScript aur Electron apps, .NET assemblies aur websites ko inspect karte hain. Yahi tools aap apne terminal se bhi chala sakte hain. Analysis aapki machine par local chalta hai, aur results mein har nateeje ke peeche ka evidence aur uski limitations shaamil hoti hain.

Setup REA ko aapke agent ke saath register karta hai aur matching workflow instructions install karta hai. Native analysis ke liye pehle se install Hopper, Ghidra ya IDA use ho sakta hai; aapki approval milne par setup Hopper install bhi kar sakta hai. Static JavaScript analysis ke liye kisi native analysis engine ki zaroorat nahi hai.

> **[REA website dekhiye](https://rea.tools/)**, jahan setup instructions, illustrated guides aur real case studies milenge.

## Quick start

### Apna agent set up karein

Node.js aur npm install hone ke baad yeh chalaiye:

```bash
npx rea-agents setup
```

Apne agents chuniye, proposed changes review kijiye aur unhe approve kijiye. Setup REA ka MCP server aur matching workflow instructions add karta hai, aur maujooda configuration ka backup rakhta hai. Iske baad apna agent restart kijiye.

Setup Claude Code, Codex, Cursor, Gemini CLI, Grok Build aur [doosre agents](docs/installation.md#supported-agents) ko support karta hai. Provider configuration aur manual MCP registration ke liye [installation aur setup](docs/installation.md) dekhiye.

### Apne agent se poochiye

```text
Notes app mein search kaise kaam karta hai yeh samjho, mujhe evidence dikhao,
aur mere project ke liye waisa hi feature banao.
```

Notes ki jagah apna target app aur woh feature likhiye jise aap samajhna chahte hain.

### Terminal use karein

Kisi extracted JavaScript/Electron app directory ya ASAR ko inspect kijiye:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Result mein modules, imports, Electron boundaries aur unka evidence hota hai. Path ki jagah apna target likhiye, jaise Windows par `"D:/apps/example"`.

Regular use ke liye `rea` command install karne ke liye:

```bash
npm install --global rea-agents
rea --help
```

Native analysis ke liye pehle ek provider configure kijiye. Native commands, provider selection, snapshots aur scripting ke liye [CLI aur Evidence guide](docs/cli.md) dekhiye.

### REA update karein

REA tezi se badalta hai, aur naye releases mein aksar bug fixes aate hain. Apna installation up to date rakhiye.

`npm install --global` ya `bun add --global` se install kiye gaye CLI ke liye:

```bash
rea update
```

Bun global updates ke liye Bun 1.2.17 ya usse naya version chahiye. Purane Bun release par `rea update` chalane se pehle Bun ko manually upgrade kijiye.

Apne agent registrations aur skill ko refresh karne ke liye woh setup command chalaiye jo update print karta hai.

Agar aap `npx` use karte hain, to apna agent setup isse update kijiye:

```bash
npx rea-agents@latest setup
```

Setup changes review kijiye aur apna agent restart kijiye. Ek baar ke CLI commands ke liye `npx rea-agents@latest` ke baad command likhiye. Bun ke saath `npx rea-agents@latest` ki jagah `bunx rea-agents@latest` use kijiye.

## REA kaise kaam karta hai

Aapka agent target ko inspect karne aur relevant code trace karne ke liye MCP ke zariye REA ko call karta hai. REA findings ko unke evidence ke saath return karta hai. Agent inhi ke aadhaar par follow-up sawaal poochta hai, behavior samjhata hai, ya implementation likhkar test karta hai. CLI commands bhi yahi workflows use karte hain.

![REA investigation flow: aapka agent ek local target ke baare mein poochta hai, REA analysis tools se use inspect aur trace karta hai, aur agent return hue code, references aur unknowns ko explain, implement aur test karne ke liye use karta hai.](website/public/assets/figures/rea-investigation-flow.svg)

[Full-size figure kholiye](website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Aap kya analyze kar sakte hain

REA ko Node.js 22.x (>=22.19), 24.x (>=24.11) ya 26+ aur npm chahiye. Baaki tools aur host support target par depend karte hain:

| Target                 | REA kya return karta hai                                                             | Requirements aur guide                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Native binaries        | Pseudocode, assembly, strings, symbols, calls aur references                         | Hopper, Ghidra ya IDA; [native analysis](https://rea.tools/guides/native/)                                                            |
| Offline ELF layout     | Sections, segments, original symbols/relocations aur static mitigation candidates    | Linux x64 par caller ka diya hua pwntools; [binary diagnostics](docs/binary-diagnostics.md)                                           |
| Go binaries            | Embedded compiler version, modules, replacements aur build settings                  | Built-in static ELF/PE/thin Mach-O inspection; Go install karne ki zaroorat nahi                                                      |
| WASM artifact          | Validation, sections, exact import/export WAT forms aur decoded WAT                  | Caller ka diya hua WABT 1.0.42; `inspect_wasm_artifact`                                                                               |
| EVM bytecode           | Dispatch selectors, byte offsets, inferred arguments aur mutability                  | Linux x64 par local raw/hex carrier; [offline EVM guide](docs/evm-bytecode.md)                                                        |
| SQLite databases       | Tables, columns, indexes, views, triggers aur chuni hui ordinary-table rows          | Local database/WAL snapshot; Node.js 24.x >=24.15 ya 26+, native SQLite limits ke saath                                               |
| Recorded Linux crashes | Raw notes, har recorded thread ke registers/signals aur optional mapping candidates  | Linux x64 par caller ka diya hua pwntools; optional GDB/pwndbg; [recorded crashes](docs/recorded-crashes.md)                          |
| JavaScript / Electron  | Modules, imports, source maps, routes, IPC aur native add-on relationships           | Node.js aur npm; [application analysis](https://rea.tools/guides/javascript/)                                                         |
| Websites               | Page structure, scripts, network observations aur maange gaye screenshots            | Chrome-family browser; [browser analysis](https://rea.tools/guides/browser/)                                                          |
| Saved network captures | Requests, responses, exposed payloads aur source locations                           | HAR ya Fiddler Everywhere SAZ; native mitmproxy ke liye Linux par mitmdump; [capture guide](docs/web-network-captures.md)             |
| .NET assemblies        | Metadata, CIL instructions, declared native dependencies aur build comparisons       | Kuch nahi (sirf static); [managed-code guide](docs/managed-code-analysis.md)                                                          |
| Android APKs           | Manifest declarations, classes, decompiled methods aur references                    | Linux/macOS/Windows x64 par headless JADX aur full JDK; [Android guide](docs/android-analysis.md)                                     |
| Android devices        | Devices, packages, processes, logs, dumps, screen captures aur APK/file transfers    | Caller ka diya hua adb (emulator ya hardware); [ADB guide](docs/adb-device-analysis.md)                                               |
| JEB projects           | Engine-backed project units, artifact digests aur type/method pseudo-code            | Caller ka start kiya hua, MCP serve karne wala JEB client, jo REA_JEB_MCP_URL se select hota hai; [JEB guide](docs/jeb-analysis.md)   |
| Android resources      | Decoded manifest, string tables, locales aur version facts                           | Caller ka diya hua Apktool launcher; [resource guide](docs/apktool-resource-analysis.md)                                              |
| Flutter apps           | Dart snapshot hash, per-ABI library digests aur engine build provenance              | Kuch nahi (static APK parsing); [Flutter guide](docs/flutter-analysis.md)                                                             |
| Firmware               | Regions, extraction results aur native-analysis handoffs                             | Linux par Binwalk / Unblob; [firmware guide](docs/firmware-analysis.md)                                                               |
| Recorded packets       | Chune hue fields, repeated values, filters aur decode-as rules                       | Linux: TShark 4.x + prlimit; [capture guide](docs/packet-captures.md)                                                                 |
| Packet summaries       | Endpoints, DNS, TLS SNI, protocol distribution aur HTTP requests                     | Caller ke diye hue tshark aur capinfos (Linux-verified); [pcap guide](docs/pcap-analysis.md)                                          |
| Recorded logic signals | Decoder annotations, sample ranges aur diagnostics                                   | Linux: sigrok-cli 0.7.2 + prlimit; [signal recordings](docs/signal-recordings.md)                                                     |
| Packages aur resources | File inventories, digests, plists, Apple bundle anatomy aur extracted resources      | [Artifact aur JavaScript guide](docs/javascript-artifact-reconstruction.md), [Apple applications](docs/apple-application-analysis.md) |
| Process behavior       | Terminal output, interactions, exit aur filesystem observations, aur run comparisons | Native PTY wala Linux/macOS; [process capture](docs/process-capture.md)                                                               |

Static JavaScript aur .NET inspection di gayi files ko padhte hain, application ko chalate nahi. Runtime capture chune gaye target ko aapki user permissions ke saath chalata hai ya usse interact karta hai; har runtime guide apne effects batati hai.

<a id="choosing-a-deep-analysis-provider"></a>

Native formats aur host support har provider mein alag hote hain. [Hopper aur Ghidra setup](docs/installation.md#hopper), [IDA guide](docs/ida-provider.md) (jisme ek optional native MCP bridge bhi shaamil hai) aur [experimental Windows Ghidra support](docs/windows-ghidra-p0.md) dekhiye. Ghidra [16-bit DOS analysis](docs/ghidra-dos.md) bhi support karta hai. Badi binaries ke liye provider ki startup deadline `REA_GHIDRA_STARTUP_TIMEOUT_MS` ya `REA_HOPPER_STARTUP_TIMEOUT_MS` se badhaiye. Provider selection ke liye [CLI guide](docs/cli.md#choose-a-provider) dekhiye. Latest npm release ke baad add hue features ke liye [release availability](docs/installation.md#released-package-and-main) check kijiye.

## Showcases

[![DX-Ball sound-pan, Notion clipboard-bridge aur TH04 bullet-ring showcases ke illustrations](docs/assets/rea-showcases.png)](https://rea.tools/showcase/)

### DX-Ball: sound-pan calculation ko reconstruct karna

Ek sound call ko uske position-to-pan helper tak follow kijiye, instructions inspect kijiye, aur adhoore pseudocode ko C mein badaliye. Yeh reconstruction 3,205 original-x86 cases pass karta hai aur compiled function ke saare 63 bytes reproduce karta hai.

[Case study padhiye](https://rea.tools/showcase/dx-ball/) ·
[Reconstruction repository](https://github.com/N0zoM1z0/dx-ball)

### Notion: Electron clipboard bridge ko trace karna

Renderer ka clipboard API dhoondhiye, use preload aur IPC ke zariye main process tak follow kijiye, aur rich clipboard format inspect kijiye.

[Case study padhiye](https://rea.tools/showcase/notion/)

### TH04: DOS bullet-ring calculation ko recover karna

Original PC-98 game ke 16-bit instructions inspect kijiye, fixed aur aimed angle calculations recover kijiye, aur reconstructed C++ ko historical compiler output se compare kijiye.

[Case study padhiye](https://rea.tools/showcase/th04/) ·
[Reconstruction repository](https://github.com/N0zoM1z0/th04)

Agar aapne REA ko kisi interesting cheez par use kiya hai, to hum use zaroor dekhna chahenge. Apna case kisi [issue](https://github.com/morluto/rea/issues) ya [pull request](https://github.com/morluto/rea/pulls) mein share kijiye, jisme target, aapka sawaal, REA ne kaise madad ki, aur aapko kya mila, yeh sab ho.

## FAQ

<details>
<summary><strong>Kaun se agents REA use kar sakte hain?</strong></summary>

Koi bhi agent jo local MCP servers support karta hai. Setup [supported agents](docs/installation.md#supported-agents) ko configure karta hai; doosre clients [manual MCP registration](docs/installation.md#mcp-registry) use kar sakte hain.

</details>

<details>
<summary><strong>Kya mujhe Hopper, Ghidra ya IDA chahiye?</strong></summary>

Deep native analysis inme se kisi ek ko use karta hai. Static JavaScript aur .NET inspection bina native analysis engine ke kaam karte hain. Approval ke baad setup Hopper install kar sakta hai; Ghidra aur IDA ke liye aapke maujooda installations use hote hain. [Provider setup](docs/installation.md#hopper) dekhiye.

</details>

<details>
<summary><strong>Kya mujhe pehle Hopper start karna hoga?</strong></summary>

Jab kisi operation ko zaroorat hoti hai, REA khud Hopper start kar deta hai. macOS par first-run dialog aapse demo mode chunne ya apna license activate karne ko keh sakta hai. Apne pehle CLI/MCP operation ya unattended job se pehle usi user session mein yeh prompt poora kijiye. Zaroorat ho to Hopper manually kholiye. [Hopper startup aur troubleshooting](docs/installation.md#launcher-paths-and-troubleshooting) dekhiye.

</details>

<details>
<summary><strong>skills.sh se skill install karne par kya hota hai?</strong></summary>

Skill aapke agent ko investigation instructions deta hai. REA ka MCP server register karne aur matching instructions install karne ke liye `npx rea-agents setup` chalaiye, phir apna agent restart kijiye. [Skill-only installation](docs/installation.md#skill-only-installation) dekhiye.

</details>

<details>
<summary><strong>REA kaun sa code return karta hai?</strong></summary>

Native analysis pseudocode aur assembly return karta hai. JavaScript/Electron analysis modules aur unke relationships recover karta hai. Aapka agent in findings se implementation likhta aur test karta hai; [showcases](#showcases) mein poore examples diye gaye hain.

</details>

<details>
<summary><strong>Kya REA mera app upload karta hai?</strong></summary>

REA targets ko local analyze karta hai. Aapke agent ko tool results milte hain, aur uske model provider ki apni data policy hoti hai.

</details>

<details>
<summary><strong>Bug mile to mujhe kya karna chahiye?</strong></summary>

Pehle update kijiye; ho sakta hai kisi recent release mein woh pehle hi fix ho chuka ho.

`npm install --global` ya `bun add --global` se install kiye gaye CLI ke liye:

```bash
rea update
```

`npx` ke zariye agent setup ke liye:

```bash
npx rea-agents@latest setup
```

Agar aap agent use kar rahe hain, to [setup refresh](#rea-update-karein) poora kijiye aur use restart kijiye. Wahi task dobara try kijiye. Agar problem bani rahe, to apne REA version, target type, reproduce karne ke steps aur error output ke saath [issue kholiye](https://github.com/morluto/rea/issues).

</details>

## Documentation

Website ki [worked guides](https://rea.tools/guides/) se shuru kijiye. Exact options, prerequisites aur result contracts ke liye:

- [Installation aur setup](docs/installation.md): agent registration, provider configuration, updates aur uninstall.
- [Readiness aur troubleshooting](docs/installation.md#check-readiness-for-your-task): kisi ek agent ya analysis engine ko diagnose karna.
- [CLI aur Evidence](docs/cli.md): commands, provider selection, snapshots, import/export aur exit statuses.
- [MCP contracts](docs/mcp-contracts.md) aur [agent prompts](docs/mcp-prompts.md): tool results, sessions aur guided investigations.
- [Tool catalog](docs/mcp-contracts.md#generated-catalog): tools, providers aur CLI commands ki generated inventory.
- [Roadmap](docs/roadmap.md): planned kaam aur capability trackers.

Vulnerabilities [SECURITY.md](SECURITY.md) ke zariye report kijiye.

## Star history

🎉 **170,000 GitHub stars — bahut bahut shukriya!**

REA use karne, bugs report karne, features request karne, builds test karne aur fixes contribute karne wale sabhi logon ka shukriya.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA ki GitHub star history" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Disclaimer

Responsible-use guidance ke liye [DISCLAIMER.md](DISCLAIMER.md) dekhiye.

Illegal ya unauthorized use par project ka stand REA ke saare versions, distribution channels aur platforms par laagu hota hai; har copy ke apne applicable licenses bane rehte hain.

REA lawful research, education, interoperability, software preservation, aur us software ke analysis ke liye hai jiske aap owner hain ya jise examine karne ke liye aap authorized hain.

## Contributing

REA mein aapki madad ka swagat hai! Bug report karne ya feature suggest karne ke liye [issue kholiye](https://github.com/morluto/rea/issues), ya code aur docs behtar karne ke liye [pull request bhejiye](https://github.com/morluto/rea/pulls).

Development setup aur checks ke liye [CONTRIBUTING.md](CONTRIBUTING.md), verification lanes ke liye [testing](docs/testing.md), aur project structure ke liye [architecture map](docs/architecture.mermaid) dekhiye.

## License

[MIT](LICENSE)

REA-authored code MIT ke under licensed hai. Third-party material ke apne licenses aur copyright notices bane rehte hain; dependency inventory, preserved license texts aur external-tool terms ke liye [Third-party notices](THIRD_PARTY_NOTICES.md) dekhiye.

**Commercial tools aapko legally obtain karne honge aur unhe use karne ke liye authorized hona hoga**, jisme IDA Pro / Hex-Rays decompilers, Hopper aur JEB shaamil hain, unke applicable licenses ke under. REA koi tool license, key ya activation entitlement nahi deta. Trials aur demos vendor terms ke adheen rehte hain, jisme user, feature, automation aur output sharing restrictions shaamil hain. Cracked copies, stolen keys, unauthorized key sharing aur license restrictions ko bypass karna authorized nahi hai. Yeh guidance MIT ya third-party licenses ko amend nahi karti.
