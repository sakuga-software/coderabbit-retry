# demo/record.sh runs this tape, then encodes docs/demo.gif from the frames.
Output demo/frames/

Set Shell zsh
Set FontSize 16
Set Width 1180
Set Height 760
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
Sleep 20s
Down@400ms 5
Sleep 1s
Type "a"
Sleep 1.5s
Type "y"
Sleep 4s
Sleep 3s
