import net from "node:net";

/**
 * Minimal SMTP server for tests. Speaks just enough of the protocol for nodemailer
 * (EHLO / AUTH PLAIN+LOGIN / MAIL / RCPT / DATA / RSET / QUIT) and records every
 * message it accepts, so the real send path can be verified without a live mailbox.
 */
export function startFakeSmtp({ port = 0, failFor = [] } = {}) {
  const messages = [];

  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { from: null, to: [], data: "" };
    let authStep = null;

    const send = (line) => socket.write(`${line}\r\n`);

    send("220 fake.localhost ESMTP ready");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      for (;;) {
        const breakAt = buffer.indexOf("\r\n");
        if (breakAt === -1) break;
        const line = buffer.slice(0, breakAt);
        buffer = buffer.slice(breakAt + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ from: current.from, to: [...current.to], data: current.data });
            const rejected = current.to.find((addr) => failFor.includes(addr));
            current = { from: null, to: [], data: "" };
            send(rejected ? `550 No such user: ${rejected}` : `250 OK queued ${messages.length}`);
          } else {
            // undo dot-stuffing
            current.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }

        if (authStep === "username") {
          authStep = "password";
          send("334 UGFzc3dvcmQ6");
          continue;
        }
        if (authStep === "password") {
          authStep = null;
          send("235 2.7.0 Authentication successful");
          continue;
        }

        const upper = line.toUpperCase();

        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          send("250-fake.localhost");
          send("250-AUTH PLAIN LOGIN");
          send("250-SIZE 52428800");
          send("250 8BITMIME");
        } else if (upper.startsWith("AUTH LOGIN")) {
          authStep = "username";
          send("334 VXNlcm5hbWU6");
        } else if (upper.startsWith("AUTH PLAIN")) {
          if (line.trim().split(/\s+/).length >= 3) send("235 2.7.0 Authentication successful");
          else {
            authStep = "password";
            send("334 ");
          }
        } else if (upper.startsWith("MAIL FROM")) {
          current.from = (line.match(/<([^>]*)>/) || [, ""])[1];
          send("250 OK");
        } else if (upper.startsWith("RCPT TO")) {
          current.to.push((line.match(/<([^>]*)>/) || [, ""])[1]);
          send("250 OK");
        } else if (upper === "DATA") {
          inData = true;
          send("354 End data with <CR><LF>.<CR><LF>");
        } else if (upper === "RSET") {
          current = { from: null, to: [], data: "" };
          send("250 OK");
        } else if (upper === "QUIT") {
          send("221 Bye");
          socket.end();
        } else if (upper.startsWith("NOOP")) {
          send("250 OK");
        } else {
          send("250 OK");
        }
      }
    });

    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        messages,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
