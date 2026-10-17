import { PREVIEW_NAVIGATION_MESSAGE } from "../shared/preview-navigation"

/** Generated previews have an opaque origin: report link clicks to the pane
 * instead of navigating the frame invisibly to its history controls. */
export function previewNavigationScript(origin: string, assetPrefix: string, originalPrefix: string) {
  const config = JSON.stringify({ origin, assetPrefix, originalPrefix, type: PREVIEW_NAVIGATION_MESSAGE }).replaceAll("<", "\\u003c")
  return `<script data-stillon-preview-navigation>(()=>{
    if(parent===window)return;
    const config=${config};
    document.addEventListener('click',event=>{
      if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      const link=event.target instanceof Element?event.target.closest('a[href]'):null;
      if(!link||link.hasAttribute('download')||(link.target&&link.target!=='_self'))return;
      const href=link.getAttribute('href');
      if(!href||href.startsWith('#'))return;
      const url=new URL(href,document.baseURI);
      if(url.origin!==config.origin)return;
      const prefix=[config.assetPrefix,config.originalPrefix].find(prefix=>url.pathname.startsWith(prefix));
      if(!prefix)return;
      event.preventDefault();
      parent.postMessage({type:config.type,address:config.originalPrefix+url.pathname.slice(prefix.length)+url.search+url.hash},config.origin);
    });
  })()</script>`
}
