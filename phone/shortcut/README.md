# Feed from your iPhone with the Share Sheet

This makes a Shortcut called "Feed TeezMind". When you tap Share on a web page, a video or some text and pick it, the link goes to your server, which reads it and files notes in your vault. There is no notification when it is done: the title and the result show up in the **Feed** tab of the TeezOS app.

You need to be connected to Tailscale on your phone. The address below only works on your tailnet.

## Build it

1. Open the **Shortcuts** app and tap **+** to make a new shortcut.
2. Tap the name at the top and call it **Feed TeezMind**.
3. Tap the **i** (info) button at the bottom. Turn on **Show in Share Sheet**. Under **Share Sheet Types**, keep only **URLs** and **Text** ticked, then tap Done.
4. Add the action **Get Contents of URL** (search "Get Contents of URL").
   - Set the URL to `https://teez-phone.example.ts.net/api/feed`
   - Tap **Show More**. Set **Method** to **POST**.
   - Under **Request Body**, choose **JSON**. This sends the header `Content-Type: application/json`, which the server requires: any other request body type (Form, File) is refused with a 415 error.
   - Tap **Add new field**, choose **Text**, and set the key to `url` and the value to the **Shortcut Input** variable (tap the value box, pick **Shortcut Input** from the variable list).
   - If you want to share plain text instead of a link, use the key `text` instead of `url`. Only use one of the two, never both.
5. Add the action **Show Notification**. Set the text to something like "Sent to TeezMind". The server answers straight away with "accepted", and files the notes in the background (about a minute).

## Use it

1. In Safari, a YouTube video or any app with a Share button, tap **Share**.
2. Scroll down and tap **Feed TeezMind**.
3. You see the "Sent to TeezMind" notification. Open the TeezOS app and go to the **Feed** tab a minute later to see the title and whether it worked.

## If something goes wrong

- "Could not connect": make sure Tailscale is on, on your phone.
- A 403 error: your phone is not signed in to Tailscale as the right account.
- A 400 error: the link is not an http or https link, or the Shortcut sent both `url` and `text`.
- A 409 error: that link is already waiting in the queue.
- A 415 error: the Request Body is not set to **JSON** (the server only accepts `Content-Type: application/json`).
- Sharing the same link twice is safe: the second time nothing new is written.
