# Lancé par demo/record.sh, qui encode docs/demo.gif à partir des images.
Output demo/frames/

Set Shell zsh
Set FontSize 16
Set Width 1180
Set Height 640
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "export PS1='$ ' && alias coderabbit-retry='./node_modules/.bin/tsx --tsconfig demo/tsconfig.json demo/demo.tsx' && clear"
Enter
Sleep 500ms
Show

Type "coderabbit-retry --watch"
Sleep 600ms
Enter
Sleep 28s
Sleep 3s
