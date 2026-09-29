# 第三方组件声明

TransMate 的 `timezone.js` 第 4 行到第 3232 行是打包后的第三方库产物，来自
`libphonenumber-js` 与 `franc` 两个库，不是本项目自己的代码。这一段由构建流程整体生成，
升级依赖时整段替换，请勿手改。

两个库均为 MIT 许可，与本项目使用的 MIT 许可兼容。按照 MIT 的要求，下面保留它们
各自的版权声明与许可全文。

| 组件 | 版本 | 许可 | 在本项目中的用途 |
| --- | --- | --- | --- |
| [libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js) | 1.13.12 | MIT | 由客户电话号码推断归属国家与地区，用于时区与语言识别 |
| [franc](https://github.com/wooorm/franc) | 6.2.0 | MIT | 识别客户消息文本的语言，用于自动语言判定 |

---

## libphonenumber-js 1.13.12

(The MIT License)

Copyright (c) 2016 @catamphetamine <purecatamphetamine@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## franc 6.2.0

(The MIT License)

Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com>
Copyright (c) 2008 Kent S Johnson
Copyright (c) 2006 Jacob R Rideout <kde@jacobrideout.net>
Copyright (c) 2004 Maciej Ceglowski

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## 开发依赖

以下依赖仅用于开发与质量检查，不会进入发布的扩展包，均为 MIT 许可：

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| [acorn](https://github.com/acornjs/acorn) | 8.18.0 | MIT |
| [eslint](https://github.com/eslint/eslint) | 9.39.5 | MIT |
| [globals](https://github.com/sindresorhus/globals) | 16.5.0 | MIT |

开发依赖的完整清单与许可信息可查看 `package-lock.json`。
