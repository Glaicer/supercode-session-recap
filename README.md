# supercode.recap

TUI-плагин OpenCode: секция `Recap` в сайдбаре сессии. По клику сворачивает хвост
сессии в короткий Markdown — «над чем работаем / сделано / следующее» — и рисует его
прямо в сайдбаре, не добавляя ничего в тред.

Один файл `recap.tsx`, без сборки и без npm-зависимостей: рантайм транспилирует JSX сам.

## Как работает

1. Транскрипт — хвост сессии (последние 20 сообщений), только `text`-части, из реактивного
   состояния TUI (`api.state.session.messages`), не по HTTP.
2. Recap Model — укороченная цепочка (полная с опциями — тикет 02): `small_model` из конфига →
   модель последнего ассистентского сообщения.
3. Recap Session — одноразовая дочерняя сессия (`parentID`, `title: "recap"`); в ней один
   синхронный `session.prompt` со своим `system` и всеми тулами, выставленными в `false`
   (+ `"*": false` — пробник показал, что MCP-тулы через id-список не гасятся).
4. Markdown берётся из `parts` ответа; Recap Session удаляется в `finally` (неуспех удаления —
   тост). Ошибки вызова — тост, предыдущий Recap не трогается.

## Установка

Симлинк файла в директорию плагинов и запись в `tui.json` — **нужны оба шага**: сканер
TUI-плагинов читает список из `tui.json` (`plugin`), а не сканирует директорию (проверено
на 1.18.21, см. `.scratch/039-tui-session-recap/probe/RESULTS.md`).

```bash
ln -sf "$PWD/recap.tsx" ~/.config/opencode/plugins/recap.tsx
```

Глобальный `~/.config/opencode/tui.json` (или локальный `<project>/.opencode/tui.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/home/<you>/.config/opencode/plugins/recap.tsx"]
}
```

Опции передаются кортежем (тикет 02): `"plugin": [["<path>", { ... }]]`.

## Проверка

```bash
opencode   # открыть TUI в любом проекте
# ctrl+p → «plugins» → supercode.recap должен быть в списке со статусом active
# начать сессию, написать пару сообщений, кликнуть «Recap» в сайдбаре
```

Ожидаемо: кнопка меняется на `Generating…`, затем под ней появляется Markdown ровно с
тремя разделами — `Working on:` / `Done:` / `Next:` — в этом порядке; в списке сессий
одноразовая Recap Session не остаётся (удаляется автоматически).

## Атрибуция

Идея и два приёма (регистрация слота `sidebar_content`, одноразовая сессия как one-shot
LLM-вызов) заимствованы из MIT-плагина [`streetturtle/opencode-recap`](https://github.com/streetturtle/opencode-recap);
код написан заново — разбор отличий в `Features/039-tui-session-recap.md`.
