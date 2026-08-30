const install = document.querySelector("#install");
const shortcut = document.querySelector("#install-shortcut");

if (install && shortcut && "IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    shortcut.hidden = entry.isIntersecting;
  }).observe(install);
}
