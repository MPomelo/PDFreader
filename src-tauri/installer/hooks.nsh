; Register an optional "Open with" handler. Never overwrite .pdf's default
; value or Windows UserChoice. Windows Settings remains the user's decision.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\PDFreader.PDF" "" "PDF document (PDFreader)"
  WriteRegStr HKCU "Software\Classes\PDFreader.PDF\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "Software\Classes\PDFreader.PDF\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "PDFreader.PDF" ""
  WriteRegStr HKCU "Software\MPomelo\PDFreader\Capabilities" "ApplicationName" "PDFreader"
  WriteRegStr HKCU "Software\MPomelo\PDFreader\Capabilities" "ApplicationDescription" "PDF reading, annotations and selection translation"
  WriteRegStr HKCU "Software\MPomelo\PDFreader\Capabilities\FileAssociations" ".pdf" "PDFreader.PDF"
  WriteRegStr HKCU "Software\RegisteredApplications" "PDFreader" "Software\MPomelo\PDFreader\Capabilities"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $R0 HKCU "Software\Classes\PDFreader.PDF\shell\open\command" ""
  ${If} $R0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    DeleteRegKey HKCU "Software\Classes\PDFreader.PDF"
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "PDFreader.PDF"
    DeleteRegValue HKCU "Software\RegisteredApplications" "PDFreader"
    DeleteRegKey HKCU "Software\MPomelo\PDFreader\Capabilities"
    DeleteRegKey /ifempty HKCU "Software\MPomelo\PDFreader"
    DeleteRegKey /ifempty HKCU "Software\MPomelo"
  ${EndIf}
!macroend
