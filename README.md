# teams-native-chat

로그인된 Teams 웹 클라이언트의 자체 채팅 서비스를 호출하는 CLI와 에이전트 스킬입니다. Microsoft Graph API·앱 등록·Power Automate 웹훅 없이 본인 계정으로 메시지를 보냅니다. 토큰과 쿠키는 추출하거나 저장하지 않습니다.

## 설치

Python 3, Node.js(테스트용), 설치된 `ego-browser`가 필요합니다. macOS/Linux용입니다.

```bash
git clone git@github.com:cskwork/teams-native-chat.git ~/.agents/skills/teams-native-chat
ln -s ~/.agents/skills/teams-native-chat ~/.codex/skills/teams-native-chat
ln -s ~/.agents/skills/teams-native-chat ~/.claude/skills/teams-native-chat
ln -s ~/.agents/skills/teams-native-chat/scripts/teams-native ~/.local/bin/teams-native
```

이미 경로가 존재하면 덮어쓰지 말고 기존 설치를 확인하세요. 각 상위 디렉터리가 존재하고 `~/.local/bin`이 PATH에 있어야 합니다.

## 사용

```bash
teams-native connect
teams-native chats --query '채팅방 이름'
teams-native messages --chat-id '정확한 채팅방 ID' --limit 20   # 읽기 전용, 최신순·정제된 필드만
teams-native send --chat-id '정확한 채팅방 ID' --text '전달할 내용' --dry-run
teams-native send --chat-id '정확한 채팅방 ID' --text '전달할 내용' --execute
teams-native close
```

기본은 미리보기이며 `--execute`에서만 발송합니다. 줄바꿈이 있는 내용은 `--text-file message.txt`를 사용하세요. `PASS`와 `verified:true`는 서버에 저장된 본문과 메시지 식별자 일치를 의미합니다. `SEND_OUTCOME_UNKNOWN`·`SEND_UNVERIFIED`에서는 자동 재전송하지 않습니다.

Jira 번호 등은 `--link 'A20-1234' 'https://your-site.atlassian.net/browse/A20-1234'`로 클릭 가능한 링크를 지정합니다. 해당 번호가 본문에 있어야 하며, 여러 링크는 옵션을 반복합니다. 사이트 주소는 실제 프로젝트 주소로 바꾸세요.

채팅 목록은 Teams가 동기화한 로컬 목록입니다. 채널 게시·첨부파일·멘션·스레드 답장은 지원하지 않습니다. Teams 웹이 열려 있어야 하며, 내부 인터페이스이므로 Teams 업데이트 후 호환성 확인이 필요합니다. 로그인이나 브라우저 제어권이 필요하면 명시적으로 중단합니다.

에이전트 사용 지침: [SKILL.md](SKILL.md). 구현 근거: [native-interface.md](references/native-interface.md).

## 검증

```bash
node --test scripts/core.test.mjs
python3 scripts/cli_test.py
```

2026-10-20에 실제 본인 채팅으로 CLI 발송 및 서버 재조회를 확인했습니다. 오프라인 테스트 통과가 이후 Teams 버전의 동작까지 보장하지는 않습니다.
