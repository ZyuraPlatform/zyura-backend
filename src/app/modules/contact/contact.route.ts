import { Router } from "express";
import sendMail from "../../utils/mail_sender";

const router = Router();

router.post("/send-inquiry", async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      role,
      message,
    } = req.body;

    const result = await sendMail({
      to: "info@zyura-e.com",

      subject: "New Inquiry From Zyura Website",

      textBody: `
        Name: ${fullName}
        Email: ${email}
        Phone: ${phone}
        Role: ${role}
        Message: ${message}
      `,

      htmlBody: `
        <div style="font-family:sans-serif">
          <h2>New Contact Inquiry</h2>

          <p><strong>Name:</strong> ${fullName}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Phone:</strong> ${phone}</p>
          <p><strong>Role:</strong> ${role}</p>
          <p><strong>Message:</strong> ${message}</p>
        </div>
      `,
    });

    console.log("MAIL RESULT:", result);

    res.status(200).json({
      success: true,
      message: "Inquiry submitted successfully",
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: "Failed to submit inquiry",
    });
  }
});

export default router;