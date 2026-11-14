const nameInput=document.getElementById("name"), button=document.getElementById("search"), results=document.getElementById("results");
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function search(){const q=nameInput.value.trim();results.innerHTML="";if(q.length<2){results.innerHTML='<p class="error">اكتب حرفين على الأقل.</p>';return;}
button.disabled=true;button.textContent="جارٍ البحث...";
try{const r=await fetch("/api/search?name="+encodeURIComponent(q));const rows=await r.json();if(!rows.length){results.innerHTML="<p>لا توجد نتائج مطابقة.</p>";return;}
results.innerHTML=rows.map(x=>`<article class="result"><h2>${esc(x.full_name)}</h2><div class="grid">
<div class="item"><b>العدد في الحصة الغذائية</b><span>${esc(x.food_count)}</span></div>
<div class="item"><b>العدد في الرعاية الاجتماعية</b><span>${esc(x.welfare_count)}</span></div>
<div class="item"><b>العدد في حصة الطحين</b><span>${esc(x.flour_count)}</span></div>
<div class="item"><b>تاريخ القائمة</b><span>${esc(x.list_date)}</span></div></div></article>`).join("");
}catch(e){results.innerHTML='<p class="error">حدث خطأ أثناء البحث.</p>';}
finally{button.disabled=false;button.textContent="استعلام";}}
button.addEventListener("click",search);nameInput.addEventListener("keydown",e=>{if(e.key==="Enter")search();});