<div align="center">

[English](README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · **हिन्दी** · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)

# REA: कुछ भी रिवर्स इंजीनियर करें

### बायनरी, एप्लिकेशन और रनटाइम व्यवहार पर रिवर्स इंजीनियरिंग के लिए एक MCP।

**कोई पसंद आने वाला फ़ीचर देखें। समझें कि वह बायनरी स्तर तक कैसे काम करता है।**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#current-status)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&utm_medium=badge&utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[वेबसाइट](https://rea.tools/) · [गाइड](https://rea.tools/guides/) · [उदाहरण](https://rea.tools/showcase/)**

[त्वरित शुरुआत](#त्वरित-शुरुआत) · [REA कैसे काम करता है](#rea-कैसे-काम-करता-है) · [आप क्या विश्लेषण कर सकते हैं](#आप-क्या-विश्लेषण-कर-सकते-हैं) · [उदाहरण](#उदाहरण) · [अक्सर पूछे जाने वाले प्रश्न](#अक्सर-पूछे-जाने-वाले-प्रश्न) · [दस्तावेज़ीकरण](#दस्तावेज़ीकरण)

<code>npx rea-agents setup</code>

<br />

<img src="docs/assets/rea-hopper-analysis.png" alt="REA, Hopper के अंदर अपना विश्लेषण ब्रिज शुरू करते हुए एक नेटिव बायनरी का निरीक्षण करता हुआ" width="1200" />

<br /><br />

<table aria-label="REA समुदाय">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="docs/assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>रिवर्स इंजीनियरिंग समुदाय से जुड़ें</strong>
  </a><br />
  <sub>Discord · प्रश्नोत्तर · शोकेस और डेमो</sub>
</td>
</tr>
</table>

<br />

</div>

---

किसी ऐप में ऐसा कोई फ़ीचर देखा जो आप अपने प्रोडक्ट में लेना चाहते हैं? अपने एजेंट से कहें कि REA के साथ उसकी जाँच करे। यह ऐप को उसके सोर्स कोड के बिना देख सकता है, समझा सकता है कि वह फ़ीचर कैसे काम करता है, प्रमाण दिखा सकता है, और आपके प्रोजेक्ट के लिए उसका एक संस्करण बना सकता है।

REA आपके एजेंट को नेटिव बायनरी, JavaScript और Electron ऐप, .NET असेंबली और वेबसाइटों का निरीक्षण करने के औज़ारों से जोड़ता है। आप इन्हीं औज़ारों को टर्मिनल से भी चला सकते हैं। विश्लेषण स्थानीय रूप से चलता है, और परिणामों में हर निष्कर्ष के पीछे के प्रमाण और सीमाएँ शामिल रहती हैं।

सेटअप REA को आपके एजेंट के साथ पंजीकृत करता है और मेल खाते वर्कफ़्लो निर्देश स्थापित करता है। नेटिव विश्लेषण के लिए आपके पास पहले से मौजूद Hopper, Ghidra, या IDA इंस्टॉलेशन का उपयोग किया जा सकता है; सेटअप अनुमति पर Hopper को वैकल्पिक रूप से स्थापित भी कर सकता है। स्थैतिक JavaScript विश्लेषण के लिए किसी नेटिव विश्लेषण इंजन की आवश्यकता नहीं होती।

> **[REA की वेबसाइट देखें](https://rea.tools/)** सेटअप निर्देशों, चित्रित गाइडों और वास्तविक केस स्टडीज़ के लिए।

## त्वरित शुरुआत

### अपना एजेंट सेट करें

Node.js और npm इंस्टॉल होने पर, यह चलाएँ:

```bash
npx rea-agents setup
```

अपने एजेंट चुनें, प्रस्तावित बदलावों की समीक्षा करें, और उन्हें स्वीकृत करें। सेटअप REA के MCP सर्वर और मेल खाते वर्कफ़्लो निर्देशों को जोड़ता है, साथ ही मौजूदा कॉन्फ़िगरेशन का बैकअप भी लेता है। उसके बाद अपने एजेंट को पुनः आरंभ करें।

सेटअप Claude Code, Codex, Cursor, Gemini CLI, Grok Build और [अन्य एजेंटों](docs/installation.md#supported-agents) का समर्थन करता है। प्रदाता कॉन्फ़िगरेशन और मैन्युअल MCP पंजीकरण के लिए [इंस्टॉलेशन और सेटअप](docs/installation.md) देखें।

### अपने एजेंट से पूछें

```text
Notes ऐप में सर्च कैसे काम करती है, यह समझाइए, प्रमाण दिखाइए, और मेरे प्रोजेक्ट के लिए एक मिलती-जुलती सुविधा बनाइए।
```

Notes की जगह अपने लक्ष्य ऐप का नाम और वह फ़ीचर लिखें जिसे आप समझना चाहते हैं।

### टर्मिनल का उपयोग करें

किसी निकाले गए JavaScript/Electron ऐप डायरेक्टरी या ASAR का निरीक्षण करें:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

परिणाम में मॉड्यूल, इम्पोर्ट, Electron सीमाएँ और उनके प्रमाण शामिल होते हैं। पाथ की जगह अपना लक्ष्य रखें, जैसे Windows पर `"D:/apps/example"`।

`rea` कमांड को नियमित उपयोग के लिए स्थापित करने हेतु:

```bash
npm install --global rea-agents
rea --help
```

नेटिव विश्लेषण के लिए पहले एक प्रदाता कॉन्फ़िगर करें। नेटिव कमांड, प्रदाता चयन, स्नैपशॉट और स्क्रिप्टिंग के लिए [CLI और Evidence गाइड](docs/cli.md) देखें।

### REA अपडेट करें

REA तेज़ी से बदलता है, और नई रिलीज़ में अक्सर बग फ़िक्स आते हैं। अपना इंस्टॉलेशन अद्यतन रखें।

`npm install --global` या `bun add --global` से स्थापित CLI के लिए:

```bash
rea update
```

Bun के वैश्विक अपडेट के लिए Bun 1.2.17 या बाद का संस्करण चाहिए। पुराने Bun रिलीज़ पर `rea update` चलाने से पहले Bun को मैन्युअल रूप से उन्नत करें।

अपने एजेंट के पंजीकरण और स्किल को ताज़ा करने के लिए अपडेट द्वारा मुद्रित सेटअप कमांड चलाएँ।

यदि आप `npx` का उपयोग करते हैं, तो अपने एजेंट का सेटअप इससे अपडेट करें:

```bash
npx rea-agents@latest setup
```

सेटअप में हुए बदलावों की समीक्षा करें और अपने एजेंट को पुनः आरंभ करें। एकल-उपयोग वाले CLI कमांड के लिए `npx rea-agents@latest` के बाद कमांड लिखें। Bun के साथ `npx rea-agents@latest` की जगह `bunx rea-agents@latest` का उपयोग करें।

## REA कैसे काम करता है

आपका एजेंट MCP के माध्यम से REA को बुलाकर लक्ष्य का निरीक्षण करता है और संबंधित कोड का अनुगमन करता है। REA अपने निष्कर्ष उनके प्रमाण के साथ लौटाता है। एजेंट इनका उपयोग अनुवर्ती प्रश्न पूछने, व्यवहार समझाने, या कोई कार्यान्वयन लिखकर परीक्षण करने के लिए करता है। CLI कमांड भी वही वर्कफ़्लो अपनाते हैं।

![REA जाँच प्रवाह: एजेंट किसी स्थानीय लक्ष्य के बारे में पूछता है, REA विश्लेषण औज़ारों से उसे जाँचकर अनुगमन करता है, और एजेंट लौटाए गए कोड, संदर्भों तथा अज्ञात बिंदुओं का उपयोग करके समझाता, लागू करता और परीक्षण करता है।](website/public/assets/figures/rea-investigation-flow.svg)

[पूर्ण आकार का चित्र खोलें](website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## आप क्या विश्लेषण कर सकते हैं

REA को Node.js 22.x (>=22.19), 24.x (>=24.11), या 26+ और npm चाहिए। अतिरिक्त औज़ार और होस्ट समर्थन लक्ष्य पर निर्भर करते हैं:

| लक्ष्य                            | REA क्या लौटाता है                                                                                                  | आवश्यकताएँ और गाइड                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| नेटिव बायनरी                     | स्यूडोकोड, असेंबली, स्ट्रिंग्स, प्रतीक, कॉल और संदर्भ                                                              | Hopper, Ghidra या IDA; [नेटिव विश्लेषण](https://rea.tools/guides/native/)                                                                                     |
| ऑफ़लाइन ELF लेआउट                | सेक्शन, सेगमेंट, मूल प्रतीक/रिलोकेशन और स्थैतिक शमन-उपायों के उम्मीदवार                                              | Linux x64 पर कॉलर-प्रदत्त pwntools; [बायनरी डायग्नोस्टिक्स](docs/binary-diagnostics.md)                                                                       |
| Go बायनरी                         | एम्बेडेड कंपाइलर संस्करण, मॉड्यूल, रिप्लेसमेंट और बिल्ड सेटिंग्स                                                  | अंतर्निहित स्थैतिक ELF/PE/thin Mach-O निरीक्षण; किसी Go इंस्टॉलेशन की आवश्यकता नहीं                                                                          |
| WASM आर्टिफ़ैक्ट                  | सत्यापन, सेक्शन, सटीक इम्पोर्ट/एक्सपोर्ट WAT रूप और डिकोड किया हुआ WAT                                              | कॉलर-प्रदत्त WABT 1.0.42; `inspect_wasm_artifact`                                                                                                            |
| EVM बाइटकोड                       | डिस्पैच सेलेक्टर, बाइट ऑफ़सेट, अनुमानित आर्ग्यूमेंट और म्यूटेबिलिटी                                                | Linux x64 पर स्थानीय कच्चा/हेक्स वाहक; [ऑफ़लाइन EVM गाइड](docs/evm-bytecode.md)                                                                               |
| रिकॉर्ड किए गए Linux क्रैश       | कच्चे नोट, हर रिकॉर्ड किए थ्रेड के रजिस्टर/सिग्नल और वैकल्पिक मैपिंग उम्मीदवार                                     | Linux x64 पर कॉलर-प्रदत्त pwntools; वैकल्पिक GDB/pwndbg; [रिकॉर्ड किए क्रैश](docs/recorded-crashes.md)                                                        |
| JavaScript / Electron             | मॉड्यूल, इम्पोर्ट, सोर्स मैप, रूट, IPC और नेटिव ऐड-ऑन के संबंध                                                    | Node.js और npm; [ऐप्लिकेशन विश्लेषण](https://rea.tools/guides/javascript/)                                                                                   |
| वेबसाइटें                         | पृष्ठ की संरचना, स्क्रिप्ट, नेटवर्क अवलोकन और अनुरोधित स्क्रीनशॉट                                                  | Chrome परिवार का ब्राउज़र; [ब्राउज़र विश्लेषण](https://rea.tools/guides/browser/)                                                                             |
| सहेजे गए नेटवर्क कैप्चर          | अनुरोध, प्रतिक्रियाएँ, उपलब्ध पेलोड और स्रोत स्थान                                                                  | HAR; नेटिव mitmproxy कैप्चर के लिए Linux पर mitmdump; [कैप्चर गाइड](docs/web-network-captures.md)                                                             |
| .NET असेंबली                     | मेटाडेटा, CIL निर्देश, घोषित नेटिव निर्भरताएँ और बिल्ड तुलना                                                       | कोई नहीं (केवल स्थैतिक); [मैनेज्ड-कोड गाइड](docs/managed-code-analysis.md)                                                                                   |
| Android APK                       | मेनिफ़ेस्ट घोषणाएँ, क्लासेस, डिकंपाइल किए गए मेथड और संदर्भ                                                        | Linux/macOS/Windows x64 पर हेडलेस JADX और पूर्ण JDK; [Android गाइड](docs/android-analysis.md)                                                                  |
| Android डिवाइस                    | डिवाइस, पैकेज, प्रोसेस, लॉग, डंप, स्क्रीन कैप्चर, और APK/फ़ाइल स्थानांतरण                                          | कॉलर-प्रदत्त adb (एम्युलेटर या हार्डवेयर); [ADB गाइड](docs/adb-device-analysis.md)                                                                            |
| JEB प्रोजेक्ट                    | इंजन-आधारित प्रोजेक्ट यूनिट, आर्टिफ़ैक्ट डाइजेस्ट और टाइप/मेथड स्यूडोकोड                                          | कॉलर-शुरू किया हुआ MCP परोसने वाला JEB क्लाइंट, REA_JEB_MCP_URL से चुना जाता है; [JEB गाइड](docs/jeb-analysis.md)                                               |
| Android संसाधन                    | डिकोड किया हुआ मेनिफ़ेस्ट, स्ट्रिंग टेबल, लोकल और संस्करण तथ्य                                                     | कॉलर-प्रदत्त Apktool लॉन्चर; [संसाधन गाइड](docs/apktool-resource-analysis.md)                                                                                |
| Flutter ऐप                       | Dart स्नैपशॉट हैश, प्रति-ABI लाइब्रेरी डाइजेस्ट और इंजन बिल्ड प्रोवेनेन्स                                            | कोई नहीं (स्थैतिक APK पार्सिंग); [Flutter गाइड](docs/flutter-analysis.md)                                                                                    |
| फ़र्मवेयर                         | क्षेत्र, निष्कर्षण परिणाम और नेटिव-विश्लेषण हैंडऑफ़                                                               | Linux पर Binwalk / Unblob; [फ़र्मवेयर गाइड](docs/firmware-analysis.md)                                                                                       |
| पैकेज और संसाधन                  | फ़ाइल सूची, डाइजेस्ट, plist, Apple बंडल की संरचना और निकाले गए संसाधन                                                | [आर्टिफ़ैक्ट और JavaScript गाइड](docs/javascript-artifact-reconstruction.md), [Apple ऐप्लिकेशन](docs/apple-application-analysis.md)                            |
| प्रोसेस व्यवहार                  | टर्मिनल आउटपुट, अंतःक्रियाएँ, निकास और फ़ाइलसिस्टम अवलोकन, और रन तुलना                                              | नेटिव PTY वाले Linux/macOS; [प्रोसेस कैप्चर](docs/process-capture.md)                                                                                         |

स्थैतिक JavaScript और .NET निरीक्षण दी गई फ़ाइलों को पढ़ते हैं, ऐप्लिकेशन को चलाए बिना। रनटाइम कैप्चर आपकी उपयोगकर्ता अनुमतियों का उपयोग करके चुने हुए लक्ष्य को चलाता या उसके साथ अंतःक्रिया करता है; हर रनटाइम गाइड अपने प्रभाव बताती है।

<a id="choosing-a-deep-analysis-provider"></a>

नेटिव फ़ॉर्मेट और होस्ट समर्थन प्रदाता के अनुसार बदलते हैं। देखें [Hopper और Ghidra सेटअप](docs/installation.md#hopper), [IDA गाइड](docs/ida-provider.md), और [प्रायोगिक Windows Ghidra समर्थन](docs/windows-ghidra-p0.md)। Ghidra [16-बिट DOS विश्लेषण](docs/ghidra-dos.md) का भी समर्थन करता है। बड़ी बायनरी के लिए प्रदाता की स्टार्टअप समय-सीमा `REA_GHIDRA_STARTUP_TIMEOUT_MS` या `REA_HOPPER_STARTUP_TIMEOUT_MS` से बढ़ाएँ। प्रदाता चयन के लिए [CLI गाइड](docs/cli.md#choose-a-provider) देखें। नवीनतम npm रिलीज़ के बाद जोड़ी गई सुविधाओं के लिए [रिलीज़ उपलब्धता](docs/installation.md#released-package-and-main) जाँचें।

## उदाहरण

[![DX-Ball साउंड-पैन, Notion क्लिपबोर्ड-ब्रिज और TH04 बुलेट-रिंग उदाहरणों के चित्र](docs/assets/rea-showcases.png)](https://rea.tools/showcase/)

### DX-Ball: साउंड-पैन गणना का पुनर्निर्माण

एक साउंड कॉल का उसकी पोज़िशन-से-पैन सहायक तक अनुगमन करें, निर्देशों का निरीक्षण करें, और अधूरे स्यूडोकोड को C में बदलें। पुनर्निर्माण 3,205 मूल-x86 परीक्षण मामलों को पास करता है और संकलित फ़ंक्शन के सभी 63 बाइट्स को पुनः उत्पन्न करता है।

[केस स्टडी पढ़ें](https://rea.tools/showcase/dx-ball/) ·
[पुनर्निर्माण रिपॉज़िटरी](https://github.com/N0zoM1z0/dx-ball)

### Notion: Electron क्लिपबोर्ड ब्रिज का अनुगमन

रेंडरर के क्लिपबोर्ड API को खोजें, उसे preload और IPC के ज़रिए मुख्य प्रोसेस तक ट्रेस करें, और समृद्ध क्लिपबोर्ड प्रारूप का निरीक्षण करें।

[केस स्टडी पढ़ें](https://rea.tools/showcase/notion/)

### TH04: DOS बुलेट-रिंग गणना की पुनःप्राप्ति

मूल PC-98 गेम के 16-बिट निर्देशों का निरीक्षण करें, स्थिर और लक्ष्य-साधित कोण गणनाओं को पुनः प्राप्त करें, और पुनर्निर्मित C++ की ऐतिहासिक कंपाइलर आउटपुट से तुलना करें।

[केस स्टडी पढ़ें](https://rea.tools/showcase/th04/) ·
[पुनर्निर्माण रिपॉज़िटरी](https://github.com/N0zoM1z0/th04)

यदि आपने REA से कुछ दिलचस्प किया है, तो हम उसे देखना पसंद करेंगे। अपना केस किसी [issue](https://github.com/morluto/rea/issues) या [pull request](https://github.com/morluto/rea/pulls) में साझा करें, जिसमें लक्ष्य, आपका प्रश्न, REA ने कैसे मदद की, और आपने क्या खोजा — यह सब शामिल हो।

## अक्सर पूछे जाने वाले प्रश्न

<details>
<summary><strong>REA का उपयोग कौन-से एजेंट कर सकते हैं?</strong></summary>

कोई भी एजेंट जो स्थानीय MCP सर्वर का समर्थन करता है। सेटअप [समर्थित एजेंटों](docs/installation.md#supported-agents) को कॉन्फ़िगर करता है; अन्य क्लाइंट [मैन्युअल MCP पंजीकरण](docs/installation.md#mcp-registry) का उपयोग कर सकते हैं।

</details>

<details>
<summary><strong>क्या मुझे Hopper, Ghidra या IDA चाहिए?</strong></summary>

गहन नेटिव विश्लेषण इनमें से किसी एक का उपयोग करता है। स्थैतिक JavaScript और .NET निरीक्षण बिना नेटिव विश्लेषण इंजन के काम करते हैं। सेटअप अनुमति पर Hopper स्थापित कर सकता है; Ghidra और IDA आपके मौजूदा इंस्टॉलेशन का उपयोग करते हैं। देखें [प्रदाता सेटअप](docs/installation.md#hopper).

</details>

<details>
<summary><strong>क्या मुझे Hopper को पहले से शुरू करना होगा?</strong></summary>

REA Hopper को तब शुरू करता है जब किसी ऑपरेशन को उसकी ज़रूरत होती है। macOS पर पहली बार चलाने पर एक संवाद आ सकता है जिसमें डेमो मोड चुनने या अपनी लाइसेंस सक्रिय करने के लिए कहा जाएगा। अपना पहला CLI/MCP ऑपरेशन या अप्रबंधित जॉब शुरू करने से पहले उसी उपयोगकर्ता सत्र में उस प्रॉम्प्ट को पूरा करें। ज़रूरत हो तो Hopper को मैन्युअल रूप से खोलें। देखें [Hopper स्टार्टअप और समस्या-निवारण](docs/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>skills.sh से स्किल इंस्टॉल करने से क्या होता है?</strong></summary>

स्किल आपके एजेंट के लिए जाँच निर्देश उपलब्ध कराता है। REA के MCP सर्वर को पंजीकृत करने और मेल खाते निर्देश स्थापित करने के लिए `npx rea-agents setup` का उपयोग करें, फिर अपने एजेंट को पुनः आरंभ करें। देखें [केवल-स्किल इंस्टॉलेशन](docs/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>REA कौन-सा कोड लौटाता है?</strong></summary>

नेटिव विश्लेषण स्यूडोकोड और असेंबली लौटाता है। JavaScript/Electron विश्लेषण मॉड्यूल और उनके आपसी संबंध पुनः प्राप्त करता है। आपका एजेंट इन निष्कर्षों का उपयोग कोई कार्यान्वयन लिखने और परीक्षण करने के लिए करता है; [उदाहरण](#उदाहरण) इनके काम किए हुए उदाहरण देते हैं।

</details>

<details>
<summary><strong>क्या REA मेरी ऐप अपलोड करता है?</strong></summary>

REA लक्ष्यों का स्थानीय रूप से विश्लेषण करता है। आपके एजेंट को औज़ार के परिणाम मिलते हैं, और उसके मॉडल प्रदाता की अपनी डेटा नीति होती है।

</details>

<details>
<summary><strong>यदि किसी बग का सामना करूँ तो क्या करूँ?</strong></summary>

पहले अपडेट करें; हाल की रिलीज़ में वह पहले से ठीक हो चुका होगा।

`npm install --global` या `bun add --global` से स्थापित CLI के लिए:

```bash
rea update
```

`npx` के माध्यम से एजेंट सेटअप के लिए:

```bash
npx rea-agents@latest setup
```

यदि आप कोई एजेंट उपयोग कर रहे हैं, तो [सेटअप रीफ़्रेश](#rea-अपडेट-करें) पूरा करें और उसे पुनः आरंभ करें। वही कार्य दोबारा आज़माएँ। यदि समस्या बनी रहे, तो अपना REA संस्करण, लक्ष्य प्रकार, पुनःउत्पत्ति के चरण और त्रुटि आउटपुट के साथ [एक issue खोलें](https://github.com/morluto/rea/issues).

</details>

## दस्तावेज़ीकरण

वेबसाइट की [व्यावहारिक गाइडों](https://rea.tools/guides/) से शुरुआत करें। सटीक विकल्पों, पूर्वापेक्षाओं और परिणाम संविदाओं के लिए:

- [इंस्टॉलेशन और सेटअप](docs/installation.md): एजेंट पंजीकरण, प्रदाता कॉन्फ़िगरेशन, अपडेट और अनइंस्टॉल।
- [तत्परता और समस्या-निवारण](docs/installation.md#check-readiness-for-your-task): किसी एक एजेंट या विश्लेषण इंजन का निदान।
- [CLI और Evidence](docs/cli.md): कमांड, प्रदाता चयन, स्नैपशॉट, इम्पोर्ट/एक्सपोर्ट और निकास स्थितियाँ।
- [MCP संविदाएँ](docs/mcp-contracts.md) और [एजेंट प्रॉम्प्ट](docs/mcp-prompts.md): औज़ार के परिणाम, सत्र और निर्देशित जाँच।
- [औज़ार सूची](docs/mcp-contracts.md#generated-catalog): बिल्ड पर जनित औज़ारों, प्रदाताओं और CLI कमांड की सूची।
- [रोडमैप](docs/roadmap.md): नियोजित कार्य और क्षमता ट्रैकर।

कमज़ोरियाँ [SECURITY.md](SECURITY.md) के माध्यम से रिपोर्ट करें।

## स्टार इतिहास

🎉 **110,000 GitHub स्टार — धन्यवाद!**

REA का उपयोग करने, बग रिपोर्ट करने, सुविधाएँ माँगने, बिल्ड परीक्षण करने और फ़िक्स योगदान करने वाले सभी लोगों का धन्यवाद।

<a href="https://www.star-history.com/?repos=morluto%2Frea&type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto%2Frea&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto%2Frea&type=date" />
    <img alt="REA की GitHub स्टार इतिहास" src="https://api.star-history.com/chart?repos=morluto%2Frea&type=date" />
  </picture>
</a>

## अस्वीकरण

ज़िम्मेदार उपयोग मार्गदर्शन के लिए [DISCLAIMER.md](DISCLAIMER.md) देखें।

प्रोजेक्ट की अवैध या अनधिकृत उपयोग पर स्थिति सभी REA संस्करणों, वितरण चैनलों और प्लेटफ़ॉर्मों पर लागू होती है; हर प्रति अपने लागू होने वाले लाइसेंस बनाए रखती है।

REA कानूनी अनुसंधान, शिक्षा, अंतर-संचालनीयता, सॉफ़्टवेयर संरक्षण, और आपके स्वामित्व वाले या जाँचने हेतु अधिकृत सॉफ़्टवेयर के विश्लेषण के लिए है।

## योगदान

REA के लिए आपकी मदद की हम कद्र करते हैं! बग रिपोर्ट करने या सुविधा सुझाने के लिए [एक issue खोलें](https://github.com/morluto/rea/issues), या कोड या दस्तावेज़ बेहतर करने के लिए [एक pull request भेजें](https://github.com/morluto/rea/pulls).

विकास सेटअप और जाँच के लिए [CONTRIBUTING.md](CONTRIBUTING.md), सत्यापन पथ के लिए [परीक्षण गाइड](docs/testing.md), और प्रोजेक्ट संरचना के लिए [आर्किटेक्चर मानचित्र](docs/architecture.mermaid) देखें।

## लाइसेंस

[MIT](LICENSE)

REA-authored code is licensed under MIT. Third-party material retains its own
licenses and copyright notices; see
[Third-party notices](THIRD_PARTY_NOTICE.md) for the dependency inventory,
preserved license texts, and external-tool terms.

**You must legally obtain and be authorized to use commercial tools**, including
IDA Pro / Hex-Rays decompilers, Hopper, and JEB, under their applicable licenses.
REA grants no tool license, key, or activation entitlement. Trials and demos
remain subject to vendor terms, including user, feature, automation, and output
sharing restrictions. Cracked copies, stolen keys, unauthorized key sharing,
and bypassing license restrictions are not authorized. This guidance does not
amend MIT or third-party licenses.
