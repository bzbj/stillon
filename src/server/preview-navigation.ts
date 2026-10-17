import { PREVIEW_NAVIGATION_MESSAGE } from "../shared/preview-navigation"

/** Generated previews have an opaque origin: report link clicks to the pane
 * instead of navigating the frame invisibly to its history controls. */
export function previewNavigationScript(originalPrefix: string) {
  // Older gateways rewrite literal project URLs while replacing the base tag.
  // Escape slashes so the canonical destination survives that response rewrite.
  const config = JSON.stringify({ originalPrefix, type: PREVIEW_NAVIGATION_MESSAGE }).replaceAll("<", "\\u003c").replaceAll("/", "\\u002f")
  return `<script data-stillon-preview-navigation>(()=>{
    if(parent===window)return;
    const config=${config};
    document.addEventListener('click',event=>{
      if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      const link=event.target instanceof Element?event.target.closest('a[href]'):null;
      if(!link||link.hasAttribute('download')||(link.target&&link.target!=='_self'))return;
      const href=link.getAttribute('href');
      if(!href||href.startsWith('#'))return;
      const base=new URL(document.baseURI),url=new URL(href,base);
      if(url.origin!==base.origin)return;
      const capability=base.pathname.match(/^\\/_(?:connect|stillon)\\/preview-assets\\/[A-Za-z0-9_-]+\\//)?.[0];
      const prefix=[capability,config.originalPrefix].find(prefix=>prefix&&url.pathname.startsWith(prefix));
      if(!prefix)return;
      event.preventDefault();
      parent.postMessage({type:config.type,address:config.originalPrefix+url.pathname.slice(prefix.length)+url.search+url.hash},base.origin);
    });
  })()</script>`
}
