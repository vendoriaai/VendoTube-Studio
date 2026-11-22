# Custom NSIS script for the VendoTube Studio installer.
# Auto-included by electron-builder (build/installer.nsh is the default
# custom-include path) — see the nsis block in electron-builder.yml.

# electron-builder's assisted template has no welcome page by default; this
# macro inserts the standard MUI2 welcome page as the wizard's first page.
# It is branded with installer-sidebar.bmp (MUI_WELCOMEFINISHPAGE_BITMAP,
# set by electron-builder from the nsis.installerSidebar option).
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "VendoTube Studio turns one brief into an evidence-led documentary film — research, narration, direction, and render in one local-first workspace.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend
