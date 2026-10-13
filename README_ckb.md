<div align="center" dir="rtl">

[English](README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · **کوردی ناوەندی** · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)

# REA: هەر شتێک بە شێوەی پێچەوانە ئەندازیاری بکە

### یەک MCP بۆ ئەندازیاریی پێچەوانە لەسەر فایلە باینەرییەکان، ئەپلیکەیشنەکان و ڕەفتاری کاتی جێبەجێکردن.

**تایبەتمەندییەکت بینی کە بەدڵتە؟ تێبگە چۆن کار دەکات، تا ئاستی باینەری.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#current-status)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[ماڵپەڕ](https://rea.tools/ckb/) · [ڕێنماییەکان](https://rea.tools/ckb/guides/) · [نموونە پراکتیکییەکان](https://rea.tools/ckb/showcase/)**

[دەستپێکی خێرا](#دەستپێکی-خێرا) · [REA چۆن کار دەکات](#rea-چۆن-کار-دەکات) · [چی دەتوانیت شیکاری بکەیت](#چی-دەتوانیت-شیکاری-بکەیت) · [نموونە پراکتیکییەکان](#نموونە-پراکتیکییەکان) · [پرسیارە باوەکان](#پرسیارە-باوەکان) · [بەڵگەنامە](#بەڵگەنامە)

<code>npx rea-agents setup</code>

<br />

<img src="docs/assets/rea-hopper-analysis.png" alt="REA پردی شیکاریی خۆی لەناو Hopper دەستپێدەکات لەکاتی پشکنینی فایلێکی باینەریی ڕەسەن" width="1200" />

<br /><br />

<table aria-label="کۆمەڵگەی REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="docs/assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>بەشداری کۆمەڵگەی ئەندازیاریی پێچەوانە بکە</strong>
  </a><br />
  <sub>Discord · پرسیار و وەڵام · پیشاندانی دەستکەوت</sub>
</td>
</tr>
</table>

<br />

</div>

---

<div dir="rtl">

تایبەتمەندییەکت لە ئەپێکدا بینی کە دەتەوێت لە بەرهەمی خۆتدا هەیبێت؟ داوا لە ایجێنتەکەت بکە بە REA لێکۆڵینەوەی لەسەر بکات. دەتوانێت بەبێ کۆدی سەرچاوە ئەپەکە بپشکنێت، ڕوونی بکاتەوە چۆن تایبەتمەندییەکە کار دەکات، بەڵگەکان پیشان بدات و وەشانێک بۆ پڕۆژەکەت دروست بکات.

REA ایجێنتەکەت دەبەستێتەوە بە ئامرازەکان بۆ پشکنینی باینەریی ڕەسەن، ئەپەکانی JavaScript و Electron، کۆکردنەوەکانی .NET و ماڵپەڕەکان. هەمان ئامرازەکان لە تێرمیناڵیشەوە بەکاردەهێنرێن. شیکاری بە شێوەی ناوخۆیی جێبەجێ دەبێت و ئەنجامەکان بەڵگە و سنوورەکانی پشت هەر دەرئەنجامێک لەخۆدەگرن.

ڕێکخستن REA لەگەڵ ایجێنتەکەت تۆمار دەکات و ڕێنماییەکانی ڕێڕەوی کار دابەزاندەکات. شیکاریی ڕەسەن دەتوانێت لە دامەزراندنی هەبووی Hopper، Ghidra یان IDA کەڵک وەربگرێت؛ ڕێکخستن دەتوانێت بە پەسەندکردنت Hopper بە ئارەزوو دابمەزرێنێت. شیکاریی جێگیری JavaScript پێویستی بە هیچ بزوێنەری شیکاریی ڕەسەن نییە.

> بۆ ڕێنمایی ڕێکخستن، ڕێنمایی وێنەدار و لێکۆڵینەوەی ڕاستەقینە، **[سەردانی ماڵپەڕی REA بکە](https://rea.tools/ckb/)**.

## دەستپێکی خێرا

### ایجێنتەکەت ڕێکبخە

دوای دامەزراندنی Node.js و npm، ئەم فەرمانە جێبەجێ بکە:

```bash
npx rea-agents setup
```

ایجێنتەکانت هەڵبژێرە، گۆڕانکارییە پێشنیارکراوەکان پێداچوونەوە بکە و پەسەندیان بکە. ڕێکخستن سێرڤەری MCPی REA و ڕێنماییەکانی ڕێڕەوی کاری گونجاو زیاد دەکات، لەگەڵ پاشەکەوتی ڕێکخستنی هەبوو. پاشان ایجێنتەکەت دووبارە دەستپێبکەرەوە.

ڕێکخستن پشتگیری Claude Code، Codex، Cursor، Gemini CLI، Grok Build و [ایجێنتەکانی تر](docs/installation.md#supported-agents) دەکات. بۆ ڕێکخستنی دابینکەر و تۆماری دەستی MCP، [دامەزراندن و ڕێکخستن](docs/installation.md) ببینە.

### پرسیار لە ایجێنتەکەت بکە

```text
تێبگە گەڕان لە ئەپی Notes چۆن کار دەکات، بەڵگەکانم پیشان بدە و تایبەتمەندییەکی هاوشێوە بۆ پڕۆژەکەم دروست بکە.
```

Notes بگۆڕە بە ئەپی ئامانج و ئەو تایبەتمەندییەی دەتەوێت لێی تێبگەیت.

### بەکارهێنانی تێرمیناڵ

بۆ پشکنینی فۆڵدەری دەرهێنراوی ئەپێکی JavaScript/Electron یان فایلی ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

ئەنجامەکە مۆدیوولەکان، importەکان، سنوورەکانی Electron و بەڵگەکانیان لەخۆدەگرێت. ڕێڕەوەکە بگۆڕە بە ئامانجەکەت؛ بۆ نموونە لە Windows `"D:/apps/example"`.

بۆ دامەزراندنی فەرمانی `rea` بۆ بەکارهێنانی بەردەوام:

```bash
npm install --global rea-agents
rea --help
```

بۆ شیکاریی ڕەسەن سەرتا دابینکەرێک ڕێکبخە. بۆ فەرمانە ڕەسەنەکان، هەڵبژاردنی دابینکەر، snapshot و سکریپت‌نووسین، [ڕێنمایی CLI و Evidence](docs/cli.md) ببینە.

### نوێکردنەوەی REA

REA بە خێرایی دەگۆڕێت و وەشانە نوێیەکان زۆرجار چاککردنەوەی هەڵە لەخۆدەگرن. دامەزراندنەکەت نوێ ڕابگرە.

بۆ CLI دامەزراو بە `npm install --global` یان `bun add --global`:

```bash
rea update
```

نوێکردنەوەی جیهانیی Bun پێویستی بە Bun 1.2.17 یان نوێترە. لەگەڵ وەشانی کۆنتری Bun، سەرتا Bun بە دەستی نوێ بکەرەوە پێش جێبەجێکردنی `rea update`.

بۆ نوێکردنەوەی تۆمارەکانی ایجێنت و skill، ئەو فەرمانی ڕێکخستنە جێبەجێ بکە کە نوێکردنەوەکە پیشانی دەدات.

ئەگەر `npx` بەکاردەهێنیت، ڕێکخستنی ایجێنتەکەت بەم فەرمانە نوێ بکەرەوە:

```bash
npx rea-agents@latest setup
```

گۆڕانکارییەکانی ڕێکخستن پێداچوونەوە بکە و ایجێنتەکەت دووبارە دەستپێبکەرەوە. بۆ فەرمانە یەکجارەکانی CLI، `npx rea-agents@latest` بەکاربهێنە و پاشان فەرمانەکە. لەگەڵ Bun، `bunx rea-agents@latest` لە جیاتی `npx rea-agents@latest` بەکاربهێنە.

## REA چۆن کار دەکات

ایجێنتەکەت لە ڕێگەی MCPەوە REA بانگ دەکات بۆ پشکنینی ئامانج و شوێنکەوتنی کۆدی پەیوەندیدار. REA دۆزینەوەکان لەگەڵ بەڵگەکانیان دەگەڕێنێتەوە. ایجێنتەکە بەکاریان دەهێنێت بۆ پرسیاری شوێنکەوتوو، ڕوونکردنەوەی ڕەفتار، یان نووسین و تاقیکردنەوەی جێبەجێکردن. فەرمانەکانی CLI هەمان ڕێڕەوی کار بەکاردەهێنن.

![ڕێڕەوی لێکۆڵینەوەی REA: ایجێنتەکەت پرسیار دەکات دەربارەی ئامانجێکی ناوخۆیی، REA پشکنین و شوێنکەوتنی دەکات بە ئامرازەکانی شیکاری، و ایجێنتەکە کۆد و سەرچاوە و نەزانراوە گەڕاوەکان بەکاردەهێنێت بۆ ڕوونکردنەوە، جێبەجێکردن و تاقیکردنەوە.](website/public/assets/figures/rea-investigation-flow.svg)

[شێوەکە بە قەبارەی تەواو بکەرەوە](website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## چی دەتوانیت شیکاری بکەیت

REA پێویستی بە Node.js 22.x (>=22.19)، 24.x (>=24.11)، یان 26+ هەیە، لەگەڵ npm.
ئامرازە زیادەکان و پشتگیریی سیستەمی خانەخوێ بەپێی ئامانج دەگۆڕێن:

| ئامانج                       | REA چی دەگەڕێنێتەوە                                                           | پێداویستی و ڕێنمایی                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| باینەریی ڕەسەن               | کۆدی نیمچە، ئەسێمبڵی، سترینگ، سیمبۆل، بانگکردن و سەرچاوە                      | Hopper، Ghidra یان IDA؛ [شیکاریی ڕەسەن](https://rea.tools/ckb/guides/native/)                                                  |
| پێکهاتەی ELF بەبێ جێبەجێکردن | بەش، سێگمێنت، سیمبۆل/ڕیلۆکەیشنی ڕەسەن و کاندیدی پاراستن                       | pwntools لەلایەن بانگکەرەوە لەسەر Linux x64؛ [دیاگنۆستیکی باینەری](docs/binary-diagnostics.md)                                  |
| باینەریی Go                  | وەشانی کۆمپایلەری نێودەرهێنراو، مۆدیوول، جێگرەوە و ڕێکخستنی بیلد              | پشکنینی جێگیری ELF/PE/Mach-Oی تەنک؛ دامەزراندنی Go پێویست نییە                                                                 |
| بەرهەمی WASM                 | پشتڕاستکردنەوە، بەش، فۆڕمی WATی import/export و WATی دیکۆدکراو                | WABT 1.0.42 لەلایەن بانگکەرەوە؛ `inspect_wasm_artifact`                                                                         |
| بایتکۆدی EVM                 | هەڵبژێری دیسپاتچ، ئۆفسێتی بایت، ئارگومێنتی دەرهێنراو و گۆڕاوێتی               | هەڵگری خاو/هێکس لەسەر Linux x64؛ [ڕێنمایی EVMی ئۆفلاین](docs/evm-bytecode.md)                                                   |
| داتابەیسی SQLite             | خشتە، ستوون، ئیندێکس، بینین، تریگەر و ڕیزی هەڵبژێردراو                        | snapshotی داتابەیس/WALی ناوخۆیی؛ Node.js 24.x >=24.15 یان 26+ بە سنووری SQLiteی ڕەسەن                                          |
| کرشە تۆمارکراوەکانی Linux    | تێبینی خاو، تۆماری پرۆسێسەر/سیگناڵی هەر thread و کاندیدی نەخشە                | pwntools لەلایەن بانگکەرەوە لەسەر Linux x64؛ GDB/pwndbg ئارەزوومەندانە؛ [کرشی تۆمارکراو](docs/recorded-crashes.md)              |
| JavaScript / Electron        | مۆدیوول، import، source map، ڕێگا، IPC و پەیوەندیی زیادکراوی ڕەسەن            | Node.js و npm؛ [شیکاریی ئەپلیکەیشن](https://rea.tools/ckb/guides/javascript/)                                                  |
| ماڵپەڕ                       | پێکهاتەی پەڕە، سکریپت، تێبینی تۆڕ و وێنەی شاشەی داواکراو                      | وێبگەڕێکی خێزانی Chrome؛ [شیکاریی وێبگەڕ](https://rea.tools/ckb/guides/browser/)                                               |
| تۆماری تۆڕی پاشەکەوتکراو     | داواکاری، وەڵام، ناوەڕۆکی payload و شوێنی سەرچاوە                              | HAR یان Fiddler Everywhere SAZ؛ mitmdump لەسەر Linux بۆ تۆماری ڕەسەنی mitmproxy؛ [ڕێنمایی تۆمار](docs/web-network-captures.md) |
| کۆکردنەوەکانی .NET           | مێتاداتا، فەرمانی CIL، وابەستەیی ڕەسەنی ڕاگەیەندراو و بەراوردکردنی بیلد       | تەنها جێگیر؛ [ڕێنمایی کۆدی بەڕێوەبراو](docs/managed-code-analysis.md)                                                          |
| APKی Android                 | ڕاگەیاندنی manifest، کلاس، مێتۆدی دیکۆمپایلکراو و سەرچاوە                      | JADXی بێ GUI و JDKی تەواو لەسەر Linux/macOS/Windows x64؛ [ڕێنمایی Android](docs/android-analysis.md)                           |
| ئامێری Android               | ئامێر، پاکێج، پرۆسێس، لۆگ، دامپ، وێنەی شاشە و گواستنەوەی APK/فایل             | adb لەلایەن بانگکەرەوە (ئیمولەیتەر یان ڕەقەکاڵا)؛ [ڕێنمایی ADB](docs/adb-device-analysis.md)                                     |
| پڕۆژەی JEB                   | یەکەی پڕۆژەی پشتبەستوو بە بزوێنەر، هەش و کۆدی نیمچەی جۆر/مێتۆد                | کڵایەنتی JEB کە بانگکەر دەستپێی دەکات و MCP پێشکەش دەکات، بە REA_JEB_MCP_URL؛ [ڕێنمایی JEB](docs/jeb-analysis.md)               |
| سەرچاوەی Android             | manifestی دیکۆدکراو، خشتەی سترینگ، زمان و ڕاستیی وەشان                        | launcherی Apktool لەلایەن بانگکەرەوە؛ [ڕێنمایی سەرچاوە](docs/apktool-resource-analysis.md)                                      |
| ئەپی Flutter                 | هەشی snapshotی Dart، هەشی کتێبخانە بۆ هەر ABI و بنەچەی بیلدی بزوێنەر          | هیچ (شیکاریی جێگیری APK)؛ [ڕێنمایی Flutter](docs/flutter-analysis.md)                                                          |
| فێرم‌وێر                      | ناوچە، ئەنجامی دەرهێنان و گواستنەوە بۆ شیکاریی ڕەسەن                          | Binwalk / Unblob لەسەر Linux؛ [ڕێنمایی فێرم‌وێر](docs/firmware-analysis.md)                                                     |
| پاکێتی تۆمارکراو             | خانەی هەڵبژێردراو، بەهای دووبارە، فلتەر و یاسای دیکۆد                         | Linux: TShark 4.x + prlimit؛ [ڕێنمایی پاکێت](docs/packet-captures.md)                                                          |
| پوختەی پاکێتەکان             | خاڵەکانی کۆتایی، DNS، TLS SNI، دابەشبوونی پرۆتۆکۆل و داواکارییەکانی HTTP      | tshark و capinfosی دابینکراو لەلایەن بانگکەر (لە Linux پشتڕاستکراوەتەوە)؛ [ڕێنمایی pcap](docs/pcap-analysis.md)                 |
| سیگناڵی لۆژیکی تۆمارکراو     | تێبینی دیکۆدەر، مەودای نموونە و دیاگنۆستیک                                    | Linux: sigrok-cli 0.7.2 + prlimit؛ [تۆماری سیگناڵ](docs/signal-recordings.md)                                                  |
| پاکێج و سەرچاوە              | لیستی فایل، هەش، plist، پێکهاتەی پاکێجی Apple و سەرچاوەی دەرهێنراو            | [ڕێنمایی بەرهەم و JavaScript](docs/javascript-artifact-reconstruction.md)، [ئەپی Apple](docs/apple-application-analysis.md)    |
| ڕەفتاری پرۆسێس               | دەرچوونی تێرمیناڵ، کارلێک، تێبینی دەرچوون و سیستەمی فایل، بەراوردی جێبەجێکردن | Linux/macOS لەگەڵ PTYی ڕەسەن؛ [تۆماری ڕەفتاری پرۆسێس](docs/process-capture.md)                                                 |

پشکنینی جێگیری JavaScript و .NET فایلە پێشکەشکراوەکان دەخوێنێتەوە بەبێ جێبەجێکردنی ئەپەکە. تۆماری کاتی جێبەجێکردن ئامانجی هەڵبژێردراو جێبەجێ دەکات یان کارلێکی لەگەڵ دەکات بە مۆڵەتی بەکارهێنەرەکەت؛ هەر ڕێنماییەکی کاتی جێبەجێکردن کاریگەرییەکانی ڕوون دەکاتەوە.

<a id="choosing-a-deep-analysis-provider"></a>

فۆڕماتی ڕەسەن و پشتگیریی خانەخوێ بەپێی دابینکەر دەگۆڕێن. ببینە
[ڕێکخستنی Hopper و Ghidra](docs/installation.md#hopper)،
[ڕێنمایی IDA](docs/ida-provider.md) (لەگەڵ پردی MCPی ڕەسەنی ئارەزوومەندانە)، و
[پشتگیریی تاقیکاریی Ghidra لەسەر Windows](docs/windows-ghidra-p0.md).
Ghidra هەروەها پشتگیری [شیکاریی DOSی ١٦-بیت](docs/ghidra-dos.md) دەکات.
بۆ باینەری گەورە، وادەی دەستپێکردنی دابینکەر بەرز بکەرەوە بە
`REA_GHIDRA_STARTUP_TIMEOUT_MS` یان `REA_HOPPER_STARTUP_TIMEOUT_MS`.
بۆ هەڵبژاردنی دابینکەر، [ڕێنمایی CLI](docs/cli.md#choose-a-provider) ببینە.
[بەردەستبوونی وەشان](docs/installation.md#released-package-and-main) بپشکنە
بۆ تایبەتمەندییە زیادکراوەکان لە دوای نوێترین وەشانی npm.

## نموونە پراکتیکییەکان

[![وێنەی ڕوونکەرەوەی نموونەکانی دابەشکردنی دەنگی DX-Ball و پردی کلیپبۆردی Notion و بازنەی گولەی TH04](docs/assets/rea-showcases.png)](https://rea.tools/ckb/showcase/)

### DX-Ball: دووبارە دروستکردنەوەی حیسابی دابەشکردنی دەنگ

بانگکردنی دەنگ شوێن بکەوە بۆ یاریدەدەری گۆڕینی شوێن بۆ دابەشکردن، فەرمانەکان بپشکنە و کۆدی نیمچەی ناتەواو بگۆڕە بۆ C. دووبارە دروستکردنەوەکە ٣٬٢٠٥ کەیسی تاقیکردنەوە لەسەر x86ی ڕەسەن تێدەپەڕێنێت و هەر ٦٣ بایتی فەنکشنە کۆمپایلکراوەکە دووبارە بەرهەم دەهێنێتەوە.

[لێکۆڵینەوەکە بخوێنەرەوە](https://rea.tools/ckb/showcase/dx-ball/) ·
[کۆگای دووبارە دروستکردنەوە](https://github.com/N0zoM1z0/dx-ball)

### Notion: شوێنکەوتنی پردی کلیپبۆردی Electron

APIی کلیپبۆردی پرۆسێسی ڕێندەر بدۆزەرەوە، لە ڕێگەی preload و IPCەوە بیگەیەنە بە پرۆسێسی سەرەکی و فۆڕماتی دەوڵەمەندی کلیپبۆرد بپشکنە.

[لێکۆڵینەوەکە بخوێنەرەوە](https://rea.tools/ckb/showcase/notion/)

### TH04: گەڕاندنەوەی حیسابی بازنەی گولەی DOS

فەرمانە ١٦-بیتییەکانی یاریی ڕەسەنی PC-98 بپشکنە، حیسابی گۆشەی جێگیر و ئامانجکراو بگەڕێنەرەوە و C++ی دووبارە دروستکراو بە دەرچوونی کۆمپایلەری مێژوویی بەراورد بکە.

[لێکۆڵینەوەکە بخوێنەرەوە](https://rea.tools/ckb/showcase/th04/) ·
[کۆگای دووبارە دروستکردنەوە](https://github.com/N0zoM1z0/th04)

ئەگەر REAت بۆ ئامانجێکی سەرنجڕاکێش بەکارهێنا، حەز دەکەین بیبینین. کەیسەکەت لە [issue](https://github.com/morluto/rea/issues) یان [pull request](https://github.com/morluto/rea/pulls)دا هاوبەش بکە، لەگەڵ ئامانج، پرسیارەکەت، چۆن REA یارمەتیت دا و چیت دۆزییەوە.

## پرسیارە باوەکان

<details>
<summary><strong>کام ایجێنت دەتوانێت REA بەکاربهێنێت؟</strong></summary>

هەر ایجێنتێک کە پشتگیری سێرڤەری MCPی ناوخۆیی دەکات. ڕێکخستن [ایجێنتە پشتگیریکراوەکان](docs/installation.md#supported-agents) ڕێکدەخات؛ کڵایەنتەکانی تر دەتوانن [تۆماری دەستی MCP](docs/installation.md#mcp-registry) بەکاربهێنن.

</details>

<details>
<summary><strong>ئایا پێویستم بە Hopper، Ghidra یان IDA هەیە؟</strong></summary>

شیکاریی قووڵی ڕەسەن یەکێکیان بەکاردەهێنێت. پشکنینی جێگیری JavaScript و .NET بەبێ بزوێنەری شیکاریی ڕەسەن کار دەکەن. ڕێکخستن دەتوانێت دوای پەسەندکردن Hopper دابمەزرێنێت؛ Ghidra و IDA دامەزراندنی هەبووت بەکاردەهێنن. [ڕێکخستنی دابینکەر](docs/installation.md#hopper) ببینە.

</details>

<details>
<summary><strong>ئایا پێویستە سەرتا Hopper دەستپێبکەم؟</strong></summary>

REA کاتێک Hopper دەستپێدەکات کە ئۆپەراسیۆنێک پێویستی پێی هەبێت. لەسەر macOS، لە یەکەم جێبەجێکردندا ڕەنگە دیالۆگێک داوات لێ بکات دەمۆ هەڵبژێریت یان مۆڵەت چالاک بکەیت. ئەو داواکارییە لە هەمان دانیشتنی بەکارهێنەردا تەواو بکە پێش یەکەم ئۆپەراسیۆنی CLI/MCP یان کاری بێ چاودێری. ئەگەر پێویست بوو Hopper بە دەستی بکەرەوە. ببینە
[دەستپێکردن و چارەسەرکردنی کێشەی Hopper](docs/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>دامەزراندنی skill لە skills.sh چی دەکات؟</strong></summary>

skill ڕێنمایی لێکۆڵینەوە بۆ ایجێنتەکەت دابین دەکات. `npx rea-agents setup` بەکاربهێنە بۆ تۆماری سێرڤەری MCPی REA و دامەزراندنی ڕێنمایی گونجاو، پاشان ایجێنتەکەت دووبارە دەستپێبکەرەوە. [دامەزراندنی تەنها skill](docs/installation.md#skill-only-installation) ببینە.

</details>

<details>
<summary><strong>REA چ کۆدێک دەگەڕێنێتەوە؟</strong></summary>

شیکاریی ڕەسەن کۆدی نیمچە و ئەسێمبڵی دەگەڕێنێتەوە. شیکاریی JavaScript/Electron مۆدیوول و پەیوەندییەکانیان دەگەڕێنێتەوە. ایجێنتەکەت ئەم دۆزینەوەیان بەکاردەهێنێت بۆ نووسین و تاقیکردنەوەی جێبەجێکردن؛ [نموونە پراکتیکییەکان](#نموونە-پراکتیکییەکان) نموونەی کرداری پیشان دەدەن.

</details>

<details>
<summary><strong>ئایا REA ئەپەکەم بار دەکات؟</strong></summary>

REA ئامانجەکان بە شێوەی ناوخۆیی شیکاری دەکات. ایجێنتەکەت ئەنجامی ئامرازەکان وەردەگرێت و دابینکەری مۆدێلەکەی سیاسەتی داتای خۆی هەیە.

</details>

<details>
<summary><strong>ئەگەر تووشی هەڵە بووم چی بکەم؟</strong></summary>

سەرتا نوێ بکەرەوە؛ ڕەنگە وەشانێکی نوێ کێشەکەی چاک کردبێتەوە.

بۆ CLI دامەزراو بە `npm install --global` یان `bun add --global`:

```bash
rea update
```

بۆ ڕێکخستنی ایجێنت لە ڕێگەی `npx`:

```bash
npx rea-agents@latest setup
```

ئەگەر ایجێنت بەکاردەهێنیت، [نوێکردنەوەی ڕێکخستن](#نوێکردنەوەی-rea) تەواو بکە و دووبارە دەستپێیبکەرەوە. هەمان ئەرک دووبارە تاقی بکەرەوە. ئەگەر کێشەکە بەردەوام بوو، [issueیەک بکەرەوە](https://github.com/morluto/rea/issues) لەگەڵ وەشانی REA، جۆری ئامانج، هەنگاوەکانی دووبارەکردنەوە و دەرچوونی هەڵە.

</details>

## بەڵگەنامە

لە [ڕێنماییە پراکتیکییەکان](https://rea.tools/ckb/guides/)ی ماڵپەڕەوە دەست پێبکە.
بۆ هەڵبژاردەی ورد، پێداویستی و گرێبەستی ئەنجام:

- [دامەزراندن و ڕێکخستن](docs/installation.md): تۆماری ایجێنت، ڕێکخستنی دابینکەر، نوێکردنەوە و لابردن.
- [ئامادەیی و چارەسەرکردنی کێشە](docs/installation.md#check-readiness-for-your-task): دیاگنۆستیکی ایجێنت یان بزوێنەری شیکاریی دیاریکراو.
- [CLI و Evidence](docs/cli.md): فەرمان، هەڵبژاردنی دابینکەر، snapshot، import/export و دۆخی دەرچوون.
- [گرێبەستەکانی MCP](docs/mcp-contracts.md) و [پرۆمپتی ایجێنت](docs/mcp-prompts.md): ئەنجامی ئامراز، دانیشتن و لێکۆڵینەوەی ڕێنماییکراو.
- [کەتەلۆگی ئامراز](docs/mcp-contracts.md#generated-catalog): لیستی دروستکراوی ئامراز، دابینکەر و فەرمانی CLI.
- [نەخشەی ڕێگا](docs/roadmap.md): کاری پلانکراو و شوێنکەوتنی توانا.

لاوازییەکان لە ڕێگەی [SECURITY.md](SECURITY.md)ەوە ڕاپۆرت بکە.

## مێژووی ئەستێرە

🎉 **١١٠٬٠٠٠ ئەستێرەی GitHub — سوپاس!**

سوپاس بۆ هەموو کەسێک کە REA بەکاردەهێنێت، هەڵە ڕاپۆرت دەکات، تایبەتمەندی داوا دەکات، بیلد تاقی دەکاتەوە و چاککردنەوە پێشکەش دەکات.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="مێژووی ئەستێرەی REA لەسەر GitHub" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## ئاگاداری

بۆ ڕێنمایی بەکارهێنانی بەرپرسیارانە [DISCLAIMER.md](DISCLAIMER.md) ببینە.

The project's position on illegal or unauthorized use covers all REA versions,
distribution channels, and platforms; each copy retains its applicable licenses.

REA بۆ توێژینەوەی یاسایی، پەروەردە، گونجاندن، پاراستنی نەرمەکاڵا و شیکاریی نەرمەکاڵایە کە خاوەنیت یان مۆڵەتت هەیە بۆ پشکنینی.

## بەشداریکردن

حەز دەکەین یارمەتیمان بدەیت لە پەرەپێدانی REA! [issueیەک بکەرەوە](https://github.com/morluto/rea/issues) بۆ ڕاپۆرتکردنی هەڵە یان پێشنیاری تایبەتمەندی، یان [pull request بنێرە](https://github.com/morluto/rea/pulls) بۆ باشترکردنی کۆد یان بەڵگەنامە.

[CONTRIBUTING.md](CONTRIBUTING.md) ببینە بۆ ڕێکخستنی ژینگەی پەرەپێدان و پشکنینەکان، [ڕێنمایی تاقیکردنەوە](docs/testing.md) بۆ ڕێگاكانی پشتڕاستکردنەوە و [نەخشەی تەلارسازی](docs/architecture.mermaid) بۆ پێکهاتەی پڕۆژەکە.

## مۆڵەت

[MIT](LICENSE)

REA-authored code is licensed under MIT. Third-party material retains its own
licenses and copyright notices; see
[Third-party notices](THIRD_PARTY_NOTICES.md) for the dependency inventory,
preserved license texts, and external-tool terms.

**You must legally obtain and be authorized to use commercial tools**, including
IDA Pro / Hex-Rays decompilers, Hopper, and JEB, under their applicable
licenses. REA grants no tool license, key, or activation entitlement. Trials and
demos remain subject to vendor terms, including user, feature, automation, and
output sharing restrictions. Cracked copies, stolen keys, unauthorized key
sharing, and bypassing license restrictions are not authorized. This guidance
does not amend MIT or third-party licenses.

</div>
