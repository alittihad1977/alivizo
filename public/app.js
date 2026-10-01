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
  orderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(orderForm).entries());
    const orderId = "ALV-" + Date.now().toString().slice(-6);
    localStorage.setItem("alivizo_last_order", JSON.stringify({ orderId, ...data, createdAt: new Date().toISOString() }));
    orderSuccess.hidden = false;
    orderSuccess.textContent = `تم تسجيل الطلب المبدئي بنجاح. رقم طلبك: ${orderId} — احتفظ فيه، والخطوة التالية ستكون ربط الطلب مباشرة بقناة الاستقبال.`;
    orderForm.reset();
    orderSuccess.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
