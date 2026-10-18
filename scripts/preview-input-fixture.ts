export const previewInputHtml = `<!doctype html><meta charset="utf-8"><title>Input acceptance</title>
<style>body{font:18px system-ui;margin:24px}#editor{position:absolute;left:24px;top:100px;width:280px;height:44px;font:20px system-ui}#drag{position:absolute;left:24px;top:200px;width:100px;height:70px;background:#2479ac;color:white;touch-action:none;user-select:none}#status{position:absolute;top:300px;left:24px;white-space:pre-wrap}</style>
<h1>Input acceptance</h1><textarea id="editor" aria-label="Application text"></textarea><div id="drag">Drag me</div><pre id="status">Ready</pre><button id="cancel-button" style="position:absolute;left:24px;top:400px;width:140px;height:44px">Cancel test</button>
<script>
const key=new URL(location.href).searchParams.get('case'),editor=document.querySelector('#editor'),drag=document.querySelector('#drag');
let revision=0,dragMoves=0,dragX=0,start=0,down=false,pointerType='',ups=0,cancels=0,activations=0;
function report(){const value={revision:++revision,text:editor.value,dragMoves,dragX,down,pointerType,ups,cancels,activations};document.querySelector('#status').textContent=JSON.stringify(value);fetch('/input-state?case='+encodeURIComponent(key),{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})}
editor.addEventListener('input',report);
drag.addEventListener('pointerdown',e=>{down=true;pointerType=e.pointerType;start=e.clientX-dragX;drag.setPointerCapture(e.pointerId);report()});
drag.addEventListener('pointermove',e=>{if(down){dragX=e.clientX-start;dragMoves++;drag.style.transform='translateX('+dragX+'px)';report()}});
drag.addEventListener('pointerup',()=>{down=false;ups++;report()});drag.addEventListener('pointercancel',()=>{down=false;cancels++;report()});
const cancelButton=document.querySelector('#cancel-button');cancelButton.addEventListener('pointerdown',e=>{down=true;e.target.setPointerCapture(e.pointerId);report()});cancelButton.addEventListener('pointerup',()=>{down=false;ups++;report()});cancelButton.addEventListener('click',()=>{activations++;report()});report();
</script>`
