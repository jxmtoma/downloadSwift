# Publishing

## Release position

Video & Media Downloader saves direct HTTPS MP4/WebM/MOV/M4V files and supported
unencrypted, on-demand HTTPS HLS streams locally. It does not support insecure
HTTP media, YouTube, DRM, encrypted or live HLS, byte-range HLS, separate
audio/video tracks, paywall bypassing, or access-control bypassing. On-demand
DASH is supported, including manifests that keep audio and video apart.

Suggested short description:

> Save direct HTTPS video files and unencrypted HLS streams locally with
> progress, MP4 output, and no tracking.

Suggested listing introduction:

> Video & Media Downloader detects media on the page you choose and saves supported video
> files through a private, on-device workflow. Direct files and compatible HLS
> streams download with progress, cancellation, sensible filenames, background
> continuation, and clear completion status.

Required listing disclosure:

> Video & Media Downloader locally processes media URLs, page titles, download status, and
> limited request headers. When a user downloads a file, those limited headers
> and existing cookies may be sent back to the original HTTPS media host.
> Nothing is sent to the developer.

Use the **Tools** category. Do not list third-party site names or claim universal
compatibility. State clearly that users may download only media they have the
right to save.

## Browser release packages

Chrome and Microsoft Edge use the same ZIP. Microsoft lists every extension API
used here as supported in Edge MV3, including downloads, notifications,
offscreen documents, storage, declarative network rules, and `webRequest`.
Firefox uses the same source but needs its own ZIP because Firefox MV3 runs a
background page instead of a service worker and has no offscreen document or
`downloads.ui` API. Safari also uses the background-page package, but its manifest
omits the unsupported downloads and notifications APIs and uses Safari's native
file handoff. Do not create browser-specific source forks.

Build and check the upload package with:

```sh
node test-media.mjs && node test-hls.mjs && node test-dash.mjs && node test-mp4.mjs && node test-sites.mjs && node test-preview.mjs && node test-remux.mjs && node test-download-flow.mjs && node test-firefox.mjs && node test-safari.mjs && node test-presubmit.mjs
sh scripts/package.sh
npx --yes web-ext@10 lint --source-dir dist/firefox
```

The script produces `dist/downloadswift-<version>.zip` for Chrome and Edge and
browser-specific `dist/downloadswift-firefox-<version>.zip` and
`dist/downloadswift-safari-<version>.zip` packages.

Before claiming Edge support publicly, sideload the unpacked directory from
`edge://extensions` and complete the clean-profile test matrix below on the
current stable Edge release for macOS, Windows, and Linux.

## Apple App Store (Safari)

**Do not submit the Safari build yet.** Saving a finished file does not work:
Safari ignores the download attribute, and the file handed to the popup reads as
empty although the page that wrote it sees it complete. Everything below stands
once that is fixed.

The first Safari release is macOS-only and requires Safari 26 or later. Do not
select iOS, iPadOS, or visionOS for this build: Safari exposes the request
inspection needed here only on macOS, and the current save handoff is desktop-only.

### Test locally

1. Run the checks and package command above.
2. In **Safari → Settings → Advanced**, enable **Show features for web developers**.
3. In the **Developer** tab, choose **Add Temporary Extension** and select
   `dist/safari` or `dist/downloadswift-safari-<version>.zip`.
4. Enable the extension, grant access to the test site, and test direct MP4/WebM,
   TS-HLS, fMP4-HLS, cancellation, retry, ETA, source-tab closure, denied site
   access, HTTP rejection, Safari's file handoff, and all nine languages.

Safari removes temporary extensions after 24 hours or when Safari quits. Safari
exposes no WebExtension downloads or notifications API and does not honour a
download attribute clicked from a background page, so a finished job waits with a
**Save** button and is saved from the popup, where the click is a real user
gesture. Safari 26 is the minimum: every download writes its result through
`FileSystemFileHandle.createWritable`, which earlier releases lack, and without
it the saved file is zero bytes. Whether Safari's own save was accepted or
dismissed is not observable, so there is no completion notification or
open/show action.

### App Store Connect checklist

1. Enroll the publishing Apple Account in the Apple Developer Program.
2. Register and confirm the permanent app bundle ID
   `io.github.jxmtoma.downloadswift`. In App Store Connect, create a new macOS app
   named **Video & Media Downloader** with that ID and a private SKU such as
   `downloadswift-macos`. Use **Utilities** as the primary category.
3. Open the app's **Xcode Cloud** tab, choose **Safari Web Extension Packager →
   Upload**, and upload `dist/downloadswift-safari-<version>.zip`.
4. Complete the product, privacy, support, age-rating, rights, pricing, and
   availability fields. Select **Data Not Collected** for App Privacy: the app has
   no developer backend, analytics, advertising, or tracking.
5. Use TestFlight for a clean-profile Safari test, then attach the processed build
   to the macOS version and submit it for review.

Use the shared localized descriptions below. Suggested App Store keywords:
`video downloader,HLS,m3u8,MP4,media downloader,stream downloader`.

Use this reviewer note:

> This is a macOS Safari 26+ extension. No account is required. Open the MDN
> video element page, enable media detection, approve site access, play the
> flower video, then reopen the extension and download the detected file. All
> processing is local. Safari receives the prepared file through its native save
> flow, so this build intentionally requests no downloads or notifications
> permission. YouTube, DRM, encrypted/live streams, and access-control bypassing
> are unsupported.

For a local Xcode wrapper instead of App Store Connect's web packager, run:

```sh
xcrun safari-web-extension-packager \
  --project-location dist/safari-app \
  --app-name "Video & Media Downloader" \
  --bundle-identifier io.github.jxmtoma.downloadswift \
  --swift --macos-only --copy-resources --no-open --no-prompt --force \
  dist/safari
```

Before archiving, confirm the app target uses
`io.github.jxmtoma.downloadswift` and the extension target uses
`io.github.jxmtoma.downloadswift.Extension`; Xcode rejects an embedded extension
whose bundle ID is not prefixed by its parent app ID.

Official references: [Safari Web Extension Packager](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect),
[command-line packaging](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari),
and [temporary installation](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension).

## Store URLs and assets

- Product: `https://jxmtoma.github.io/downloadSwift/`
- Privacy: `https://jxmtoma.github.io/downloadSwift/privacy/`
- Support: `https://jxmtoma.github.io/downloadSwift/support/`
- Logo: `store-assets/icon-128.png`
- Firefox manifest icons: `icons/icon-32.png` and `icons/icon-64.png`
- Safari extension and generated app-icon source: `icon.svg` at manifest size 512
- Screenshots: `store-assets/screenshot-detected.png` and
  `store-assets/screenshot-downloading.png`
- Small promotional tile: `store-assets/small-promo-440x280.png`
- Large promotional tile: `store-assets/marquee-1400x560.png`

## Firefox Add-ons

### Account, test, and upload

1. Create or sign in to a Mozilla account, open the Add-ons Developer Hub, and
   choose **Submit a New Add-on → On this site**.
2. Confirm the permanent add-on ID
   `downloadswift@jxmtoma.github.io` before the first submission. Updates must
   keep the same ID.
3. Run the checks above. In a clean current Firefox profile, temporarily load
   `dist/firefox/manifest.json` from `about:debugging#/runtime/this-firefox` and
   test direct MP4/WebM, TS-HLS, fMP4-HLS, cancel, retry, ETA, source-tab
   closure, notification click, denied site access, HTTP rejection, and all
   nine languages.
4. Upload `dist/downloadswift-firefox-<version>.zip`, select Firefox Desktop,
   and use **Download Management** plus **Photos, Music & Videos** as the two
   categories.
5. Use the shared short description above and the localized descriptions below.
   Add the product, privacy, support, icon, and screenshots listed above.

The Firefox manifest requires Firefox 142 or later and declares required
`websiteContent` data use. This is conservative and accurate: the selected
media, request metadata, and existing cookies may be transmitted only back to
the original HTTPS media host to perform the user-requested download. Nothing
is sent to the developer, analytics, advertising, or another service.

Use these permission justifications:

- `activeTab`: read the selected tab ID and title and reload it after detection
  is enabled.
- Optional HTTPS site access and `webRequest`: detect media and capture the
  limited request context only on sites the user enables.
- `declarativeNetRequestWithHostAccess`: temporarily replay that context only
  for the selected media fetch.
- `downloads` and `downloads.open`: save and monitor the selected file, cancel
  it, reveal it in Firefox Downloads, and open it after a notification click.
- `notifications`: notify the user when a selected download finishes.
- `storage`: keep detection results and job state in browser-session memory.

Firefox notifications do not expose Chrome-style action buttons. Clicking the
Firefox completion notification opens the file; showing its folder remains
available from Firefox Downloads.

Use this reviewer note:

> No account is required. Open the MDN video element page, enable detection,
> approve site access, play the flower video, then reopen the extension and
> download the detected file. All processing is local. The packaged third-party
> library is mux.js 6.3.0 (`vendor/mux-mp4.min.js`), from the official npm
> release; readable source is at
> https://github.com/videojs/mux.js/tree/v6.3.0 and its Apache-2.0 license is
> included. YouTube, DRM, encrypted/live streams, and access-control bypassing
> are intentionally unsupported.

Mozilla requires signing for release and beta Firefox builds. For this readable
source tree, provide the mux.js release links in **Notes for Reviewers**; if AMO
asks for a source archive, upload the repository source for the exact tag with
the build command `sh scripts/package.sh`.

Official references: [submission flow](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/),
[third-party libraries](https://extensionworkshop.com/documentation/publish/third-party-library-usage/),
and [Firefox data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Microsoft Edge Add-ons

### Account, test, and upload

1. Register an individual or company Microsoft Edge developer account in
   Partner Center using a Microsoft account as Primary Owner. Registration is
   free. Choose the account type and publisher name carefully; account type
   cannot be changed later.
2. Sideload the extension in a clean Edge profile and test direct MP4/WebM,
   TS-HLS, fMP4-HLS, cancel, retry, ETA, source-tab closure, both notification
   actions, denied site access, HTTP rejection, and every supported language.
3. In **Partner Center → Edge → Create new extension**, upload the exact
   `dist/downloadswift-<version>.zip` produced by `scripts/package.sh`.
4. Choose **Public** visibility and all markets, then select the **Tools**
   category. Enter the product, privacy, and support URLs above.

### Partner Center privacy answers

Single purpose:

> Detect supported media requested by a page the user chooses and save only the
> user-selected media locally to the user's device.

Data disclosure:

> The extension locally processes media URLs, page titles, download status, and
> limited request headers. Existing browser cookies may be sent only to the
> original HTTPS media host when the user downloads a file. Nothing is sent to
> the developer, sold, shared, or used for advertising or analytics.

Select **No remote code**. `mux.js` and all executable code are packaged in the
ZIP; downloaded media and playlists are data, not executable code.

Use these permission justifications:

- `activeTab`: read the current tab ID and title when the user opens the popup,
  and reload that tab after the user enables detection.
- Optional HTTPS site access and `webRequest`: observe media URLs, response
  metadata, and limited request headers only on sites the user enables.
- `declarativeNetRequestWithHostAccess`: temporarily replay the limited request
  context required by the specific media URL the user selected.
- `downloads`: save, monitor, cancel, and show user-selected downloads.
- `downloads.open`: open a completed file only after the user selects **Open
  file** in its completion notification.
- `downloads.ui`: suppress duplicate browser download UI during the managed file
  handoff, then restore it immediately.
- `notifications`: notify the user when a selected download finishes.
- `offscreen`: fetch, prepare, and transmux a selected download without opening
  another tab.
- `storage`: keep detection results and download state in browser-session memory.

## Localized store descriptions

Use these descriptions for Microsoft Edge Add-ons, Firefox, and Safari listings.

Each description below exceeds Edge's 250-character minimum.

#### English (`en`)

> Video & Media Downloader detects media requested by the page you choose and
> saves supported files locally through a private, on-device workflow. Download
> direct HTTPS MP4, WebM, MOV, and M4V files or compatible unencrypted,
> on-demand HLS streams with progress, an estimated completion time,
> cancellation, sensible filenames, background continuation, and clear
> completion status. HLS output is saved as MP4. DASH playlist URLs can be copied,
> but DASH downloads are not supported. YouTube, DRM, encrypted or live streams,
> separate audio/video merging, paywall bypassing, and access-control bypassing
> are not supported. Download only media you own or have permission to save.

#### Español (`es`)

> Video & Media Downloader detecta el contenido multimedia solicitado por la
> página que elijas y guarda los archivos compatibles de forma local mediante un
> proceso privado realizado en el dispositivo. Descarga archivos HTTPS directos
> en formatos MP4, WebM, MOV y M4V, así como transmisiones HLS compatibles, sin
> cifrar y bajo demanda. Muestra el progreso y el tiempo estimado restante,
> permite cancelar la descarga, crea nombres de archivo claros, continúa
> trabajando en segundo plano y muestra claramente el estado final. Las
> transmisiones HLS se guardan como MP4. Puedes copiar las URL de listas DASH,
> pero la descarga de contenido DASH no está disponible. No se admiten YouTube,
> DRM, transmisiones cifradas o en directo, combinación de audio y vídeo
> separados, evasión de muros de pago ni de controles de acceso. Descarga
> únicamente contenido que poseas o que tengas permiso para guardar.

#### Français (`fr`)

> Video & Media Downloader détecte les médias demandés par la page que vous
> choisissez et enregistre localement les fichiers compatibles grâce à un
> traitement privé effectué sur votre appareil. Téléchargez des fichiers HTTPS
> directs aux formats MP4, WebM, MOV et M4V, ainsi que des flux HLS à la demande
> compatibles et non chiffrés. L'extension affiche la progression et le temps
> restant estimé, permet d'annuler un téléchargement, crée des noms de fichiers
> clairs, poursuit les téléchargements en arrière-plan et affiche clairement
> l'état final. Les flux HLS sont enregistrés au format MP4. Les URL de
> listes de lecture DASH peuvent être copiées, mais leur téléchargement n'est pas
> pris en charge. YouTube, les DRM, les flux chiffrés ou en direct, la fusion de
> pistes audio et vidéo séparées, ainsi que le contournement des péages ou des
> contrôles d'accès ne sont pas pris en charge. Téléchargez uniquement les médias
> que vous possédez ou que vous êtes autorisé à enregistrer.

#### Deutsch (`de`)

> Video & Media Downloader erkennt Medien, die von der von Ihnen ausgewählten
> Seite angefordert werden, und speichert unterstützte Dateien lokal in einem
> privaten Arbeitsablauf auf Ihrem Gerät. Laden Sie direkte HTTPS-Dateien in den
> Formaten MP4, WebM, MOV und M4V sowie kompatible, unverschlüsselte
> On-Demand-HLS-Streams herunter. Die Erweiterung zeigt Fortschritt und
> geschätzte Restzeit an, ermöglicht das Abbrechen, erstellt verständliche
> Dateinamen, setzt Downloads im Hintergrund fort und zeigt den Abschlussstatus
> an. HLS-Inhalte werden als MP4 gespeichert. URLs von DASH-Wiedergabelisten
> können kopiert werden, DASH-Downloads werden jedoch nicht unterstützt. YouTube,
> DRM, verschlüsselte oder Live-Streams, das Zusammenführen getrennter Audio- und
> Videospuren sowie das Umgehen von Paywalls oder Zugriffskontrollen werden nicht
> unterstützt. Laden Sie nur Medien herunter, die Ihnen gehören oder die Sie
> speichern dürfen.

#### Português do Brasil (`pt_BR`)

> O Video & Media Downloader detecta a mídia solicitada pela página escolhida e
> salva localmente os arquivos compatíveis por meio de um processo privado
> realizado no dispositivo. Baixe arquivos HTTPS diretos nos formatos MP4, WebM,
> MOV e M4V, além de streams HLS sob demanda compatíveis e não criptografados. A
> extensão mostra o progresso e o tempo restante estimado, permite cancelar o
> download, cria nomes de arquivo claros, continua os downloads em segundo plano
> e exibe claramente o estado final. O conteúdo HLS é salvo como MP4. URLs de
> playlists DASH podem ser copiadas, mas downloads DASH não são compatíveis.
> YouTube, DRM, streams criptografados ou ao vivo, combinação de faixas separadas
> de áudio e vídeo e contorno de paywalls ou controles de acesso não são
> compatíveis. Baixe apenas mídias que você possui ou tem permissão para salvar.

#### 日本語 (`ja`)

> Video & Media Downloader は、ユーザーが選択したページから要求されたメディアを検出し、対応するファイルを端末内だけで処理するプライベートな仕組みでローカルに保存します。HTTPS 経由の MP4、WebM、MOV、M4V の直接動画ファイルと、暗号化されていない対応オンデマンド HLS ストリームをダウンロードできます。進行状況、完了までの推定時間、キャンセル、分かりやすいファイル名、バックグラウンドでの継続、完了状態の表示に対応しています。HLS は MP4 として保存されます。DASH プレイリストの URL はコピーできますが、DASH のダウンロードには対応していません。YouTube、DRM、暗号化またはライブ配信のストリーム、分離された音声と映像の結合、ペイウォールやアクセス制御の回避には対応していません。自分が所有している、または保存する許可を得ているメディアだけをダウンロードしてください。

#### 한국어 (`ko`)

> Video & Media Downloader는 사용자가 선택한 페이지에서 요청하는 미디어를 감지하고, 지원되는 파일을 기기 안에서만 처리하는 비공개 방식으로 로컬에 저장합니다. HTTPS를 사용하는 MP4, WebM, MOV, M4V 직접 동영상 파일과 암호화되지 않은 호환 주문형 HLS 스트림을 다운로드할 수 있습니다. 다운로드 진행률과 예상 남은 시간을 표시하고, 취소 기능과 알아보기 쉬운 파일 이름을 제공하며, 원본 탭을 닫은 뒤에도 백그라운드에서 계속 다운로드하고 완료 상태를 표시합니다. HLS 콘텐츠는 MP4로 저장됩니다. DASH 재생목록 URL은 복사할 수 있지만 DASH 다운로드는 지원하지 않습니다. YouTube, DRM, 암호화되었거나 라이브인 스트림, 분리된 오디오와 동영상 트랙 병합, 페이월 또는 접근 제어 우회는 지원하지 않습니다. 본인이 소유하거나 저장 권한이 있는 미디어만 다운로드하세요.

#### 简体中文 (`zh_CN`)

> Video & Media Downloader 可检测您所选择网页请求的媒体，并通过完全在设备本地运行的私密流程保存受支持的文件。您可以下载通过 HTTPS 提供的 MP4、WebM、MOV 和 M4V 直接视频文件，以及受支持、未加密的点播 HLS 流。扩展会显示下载进度和预计剩余时间，支持取消任务、生成清晰的文件名、在来源标签页关闭后继续后台下载，并清楚显示完成状态。HLS 内容会保存为 MP4。您可以复制 DASH 播放列表网址，但暂不支持下载 DASH 内容。不支持 YouTube、DRM、加密流、直播流、分离音视频轨道的合并，也不支持绕过付费墙或访问控制。请仅下载您拥有或已获得保存许可的媒体，并遵守相关网站条款和当地法律。

#### 繁體中文 (`zh_TW`)

> Video & Media Downloader 可偵測您所選擇網頁要求的媒體，並透過完全在裝置本機執行的私密流程儲存受支援的檔案。您可以下載透過 HTTPS 提供的 MP4、WebM、MOV 和 M4V 直接影片檔案，以及受支援且未加密的隨選 HLS 串流。擴充功能會顯示下載進度和預估剩餘時間，支援取消工作、產生清楚的檔案名稱、在來源分頁關閉後繼續於背景下載，並清楚顯示完成狀態。HLS 內容會儲存為 MP4。您可以複製 DASH 播放清單網址，但目前不支援下載 DASH 內容。不支援 YouTube、DRM、加密串流、直播串流、分離音訊與影片軌道的合併，也不支援繞過付費牆或存取控制。請僅下載您擁有或已取得儲存許可的媒體，並遵守相關網站條款及當地法律。

Search terms (seven or fewer per language, within Edge's 21-word and
30-character limits):

- `en`: `video downloader`, `HLS downloader`, `m3u8 downloader`, `MP4 downloader`, `streaming video downloader`, `media downloader`, `private video downloader`
- `es`: `descargador de videos`, `descargador HLS`, `descargador m3u8`, `descargador MP4`, `descargar videos online`, `descargador multimedia`, `descarga privada de videos`
- `fr`: `téléchargeur vidéo`, `téléchargeur HLS`, `téléchargeur m3u8`, `téléchargeur MP4`, `télécharger vidéo en ligne`, `téléchargeur multimédia`, `téléchargement vidéo privé`
- `de`: `Video Downloader`, `HLS Downloader`, `m3u8 Downloader`, `MP4 Downloader`, `Videos herunterladen`, `Streaming Video speichern`, `privater Video Download`
- `pt_BR`: `baixar vídeos`, `download de vídeos`, `baixador HLS`, `baixador m3u8`, `baixador MP4`, `baixar vídeo online`, `download privado de vídeo`
- `ja`: `動画ダウンローダー`, `動画ダウンロード`, `HLS ダウンローダー`, `m3u8 ダウンローダー`, `MP4 ダウンローダー`, `ストリーミング動画保存`, `動画保存 拡張機能`
- `ko`: `동영상 다운로더`, `동영상 다운로드`, `HLS 다운로더`, `m3u8 다운로더`, `MP4 다운로더`, `스트리밍 영상 저장`, `비공개 동영상 저장`
- `zh_CN`: `视频下载器`, `视频下载`, `HLS 下载器`, `m3u8 下载器`, `MP4 下载器`, `流媒体视频下载`, `私密视频下载`
- `zh_TW`: `影片下載器`, `影片下載`, `HLS 下載器`, `m3u8 下載器`, `MP4 下載器`, `串流影片下載`, `私密影片下載`

The package declares nine locales, so use the matching description above for
each Partner Center language row. Use Partner Center's **Duplicate** action for
the same logo, screenshots, and tiles.

## Microsoft Edge certification notes

> No account or credentials are required. Open the MDN `<video>` reference page
> at https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video.
> Open the extension, choose Enable media detection, approve site access, and
> allow the tab to reload. Play the flower video, reopen the extension, and
> download the detected MP4 or WebM. The popup shows progress and ETA. When the
> download finishes, its notification offers Open file and Show in folder. All
> processing is local. YouTube, DRM, encrypted/live streams, and access-control
> bypassing are intentionally unsupported.

Submit after every locale row shows **Complete**. Microsoft says certification
can take up to seven business days.

Official references: [porting guide](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension),
[supported APIs](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support),
[developer registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account),
and [publishing flow](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension).

## Chrome Web Store

- Register the publisher, verify its email, enable 2-Step Verification, and pay
  the one-time Chrome Web Store developer fee.
- In repository **Settings → Pages**, choose **Deploy from a branch**, then
  publish `main` from `/docs`. Use these Developer Dashboard URLs:
  - Product: `https://jxmtoma.github.io/downloadSwift/`
  - Privacy: `https://jxmtoma.github.io/downloadSwift/privacy/`
  - Support: `https://jxmtoma.github.io/downloadSwift/support/`
  GitHub Pages sites are public. Keeping this source repository private requires
  GitHub Pro, Team, or Enterprise; on GitHub Free, publish `/docs` from a
  separate public site-only repository instead.
- In Privacy Practices, disclose handling of website content, media URLs, page
  titles, download status, limited request headers, and same-host cookies.
  Declare that data is processed locally, is not sold, and is not used outside
  the extension's single purpose.
- Upload `store-assets/icon-128.png`, both current 1280×800 screenshots, and
  `store-assets/small-promo-440x280.png`. The 1400×560 marquee is optional.
- Test the packed ZIP on clean Chrome profiles on macOS, Windows, and Linux:
  direct MP4/WebM, TS-HLS, fMP4-HLS, cancel, retry, source-tab closure,
  completion notification, denied site access, HTTP rejection, and each
  supported browser language.
- Upload first as **Private / trusted testers**, then move to public after the
  package and privacy declarations pass review.

## Monetization decision

Launch completely free and ad-free. Approval, reliability, reviews,
and support feedback are more valuable than early monetization.

Keep the current core free forever:

- Direct-file and supported HLS downloads
- MP4 output, filenames, progress, cancellation, and notifications
- Session download history

If Premium is reconsidered, add it only when several advanced features exist:

- Quality/variant selection and batch queues
- DASH and separate audio/video merging
- Subtitle/audio extraction and live recording
- Persistent history, filename templates, and per-site folders

Do not embed a generic advertising SDK. Manifest V3 disallows remotely hosted
JavaScript, and Chrome Web Store policy prohibits using browsing activity for
personalized advertising. If advertising is added later, use a clearly labeled,
non-personalized direct sponsor card with packaged creative and a user-clicked
destination link. Disclose it in the listing, UI, and privacy policy. A real
sponsor image and destination URL are required before adding that surface.

## Maintenance

For each release: update `manifest.json` version, update `CHANGELOG.md`, run all
checks, inspect the ZIP contents, test the unpacked release on a clean profile,
commit, tag `v<version>`, then upload the exact ZIP produced from that commit.
Review Chrome Web Store, Microsoft Edge Add-ons, Mozilla Add-on policies, and
mux.js updates before each feature release.
