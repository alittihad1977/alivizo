document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const target = document.querySelector(link.getAttribute("href"));
    if (target) {
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});
const orderForm = document.querySelector("#order-form");
const orderSuccess = document.querySelector("#order-success");
if (orderForm && orderSuccess) {
  orderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = orderForm.querySelector("button[type=submit]");
    button.disabled = true;
    button.style.opacity = ".65";
    try {
      const data = Object.fromEntries(new FormData(orderForm).entries());
      const response = await fetch("/api/orders", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "failed");
      orderSuccess.hidden = false;
      orderSuccess.textContent = `تم تسجيل طلبك بنجاح 🎉 رقم الطلب: ${result.orderId}. احتفظ بالرقم، وسنكمل معك الخطوات التالية.`;
      orderForm.reset();
      orderSuccess.scrollIntoView({ behavior:"smooth", block:"center" });
    } catch {
      orderSuccess.hidden = false;
      orderSuccess.style.background = "#fff5f5";
      orderSuccess.style.borderColor = "#f1caca";
      orderSuccess.style.color = "#8a2525";
      orderSuccess.textContent = "صار خطأ أثناء إرسال الطلب. جرّب مرة ثانية.";
    } finally {
      button.disabled = false;
      button.style.opacity = "1";
    }
  });
}
