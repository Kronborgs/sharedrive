package smtp

import (
	"fmt"
	htmlstd "html"
	"strings"
)

func roomInvitationHTML(inviterName, roomName, role, inviteLink, instanceURL string) string {
	escape := htmlstd.EscapeString
	inviter := escape(inviterName)
	room := escape(roomName)
	roleLabel := escape(roomRoleText(role))
	inviteURL := escape(inviteLink)
	baseURL := strings.TrimRight(instanceURL, "/")
	logoURL := escape(baseURL + "/logo_name.png")
	accessText := "Log ind med din Sharedrive-konto for at deltage."
	if strings.HasPrefix(role, "room_") {
		accessText = "Opret din begrænsede Rooms-konto. Den giver ikke adgang til Mine filer eller Noter."
	} else if role == "guest" {
		accessText = "Dit personlige gæstelink er tidsbegrænset og må ikke videresendes."
	}

	return fmt.Sprintf(`<!doctype html>
<html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invitation til %s</title></head>
<body style="margin:0;padding:0;background:#080b14;color:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">%s har inviteret dig til chatrummet %s på Sharedrive.</div>
<table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="background:#080b14;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="width:100%%;max-width:640px;background:#0d1220;border:1px solid #29334b;border-radius:22px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);">
<tr><td align="center" style="padding:28px 32px;background:#121827;border-bottom:1px solid #1d2639;">
<img src="%s" width="190" alt="Sharedrive" style="display:block;width:190px;max-width:70%%;height:auto;border:0;color:#f8fafc;font-size:26px;font-weight:700;">
</td></tr>
<tr><td style="padding:40px 44px 20px;">
<h1 style="margin:0;text-align:center;color:#ffffff;font-size:36px;line-height:1.15;letter-spacing:-.7px;">Du er inviteret<br>til et chatrum</h1>
<p style="margin:20px 0 30px;text-align:center;color:#a8b3c7;font-size:18px;line-height:1.55;"><strong style="color:#dbe5f5;">%s</strong> har inviteret dig<br>til at deltage som %s.</p>
<table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="background:#10182a;border:1px solid #2d68cc;border-radius:16px;"><tr>
<td width="72" align="center" style="padding:22px 0 22px 22px;"><div style="width:54px;height:54px;line-height:54px;border-radius:14px;background:#152647;color:#59a2ff;text-align:center;font-size:30px;">◫</div></td>
<td style="padding:22px 24px;color:#ffffff;font-size:26px;font-weight:700;line-height:1.25;">%s</td>
</tr></table>
<table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;"><tr>
<td width="44" valign="top" style="color:#5da4ff;font-size:25px;line-height:30px;">☵</td>
<td style="color:#aeb9cc;font-size:16px;line-height:1.6;">Deltag i samtalen, brug emoji-reaktioner og samarbejd i realtid.</td>
</tr></table>
<table role="presentation" width="100%%" cellspacing="0" cellpadding="0" border="0" style="margin-top:30px;"><tr><td align="center" bgcolor="#2563eb" style="border-radius:12px;">
<a href="%s" style="display:block;padding:17px 24px;color:#ffffff;text-decoration:none;font-size:18px;font-weight:700;line-height:1.2;">Åbn chatrum&nbsp;&nbsp;→</a>
</td></tr></table>
<p style="margin:18px 0 0;text-align:center;color:#8793a8;font-size:13px;line-height:1.6;">Hvis knappen ikke virker, kan du åbne invitationen her:<br><a href="%s" style="color:#69a8ff;word-break:break-all;">%s</a></p>
</td></tr>
<tr><td align="center" style="padding:24px 38px 32px;border-top:1px solid #1d2639;color:#7f8ba0;font-size:13px;line-height:1.65;">
<div style="margin-bottom:8px;color:#6282b4;font-size:25px;">♢</div>
%s<br>Hvis du ikke forventede invitationen, kan du roligt ignorere denne e-mail.<br>
<span style="color:#64748b;">Sendt af <a href="%s" style="color:#8ebeff;text-decoration:none;">%s</a></span>
</td></tr></table>
</td></tr></table></body></html>`, room, inviter, room, logoURL, inviter, roleLabel, room, inviteURL, inviteURL, inviteURL,
		escape(accessText), escape(baseURL), escape(baseURL))
}
