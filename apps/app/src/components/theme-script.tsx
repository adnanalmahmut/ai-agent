const themeBootstrap = `try{var t=localStorage.getItem('theme');var d=t==='dark'||((!t||t==='system')&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}`;

export function ThemeScript() {
  return (
    <script
      id="platform-theme"
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: themeBootstrap }}
    />
  );
}
