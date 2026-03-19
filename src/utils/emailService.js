const nodemailer = require('nodemailer');
const logger = require('./logger');

// Create email transporter
const createTransporter = () => {
  return nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

// Email templates
const templates = {
  'email-verification': `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify Your Tweak Music Account</title>
      <style>
        body { font-family: 'Poppins', sans-serif; background: #121212; color: white; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #181818; border-radius: 12px; padding: 30px; }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 32px; font-weight: 700; color: #ff2a5f; margin-bottom: 10px; }
        .button { display: inline-block; background: #ff2a5f; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #b3b3b3; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">Tweak</div>
          <h2>Verify Your Email Address</h2>
        </div>
        <p>Hi {{full_name}},</p>
        <p>Thank you for signing up for Tweak Music! To complete your registration, please verify your email address by clicking the button below:</p>
        <div style="text-align: center;">
          <a href="{{verification_link}}" class="button">Verify Email</a>
        </div>
        <p>This link will expire in 24 hours. If you didn't create an account, you can safely ignore this email.</p>
        <div class="footer">
          <p>Best regards,<br>The Tweak Music Team</p>
        </div>
      </div>
    </body>
    </html>
  `,
  
  'password-reset': `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset Your Tweak Music Password</title>
      <style>
        body { font-family: 'Poppins', sans-serif; background: #121212; color: white; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #181818; border-radius: 12px; padding: 30px; }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 32px; font-weight: 700; color: #ff2a5f; margin-bottom: 10px; }
        .button { display: inline-block; background: #ff2a5f; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #b3b3b3; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">Tweak</div>
          <h2>Reset Your Password</h2>
        </div>
        <p>Hi {{full_name}},</p>
        <p>We received a request to reset your password for your Tweak Music account. Click the button below to reset your password:</p>
        <div style="text-align: center;">
          <a href="{{reset_link}}" class="button">Reset Password</a>
        </div>
        <p>This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
        <div class="footer">
          <p>Best regards,<br>The Tweak Music Team</p>
        </div>
      </div>
    </body>
    </html>
  `
};

// Send email function
const sendEmail = async ({ to, subject, template, data = {} }) => {
  try {
    const transporter = createTransporter();
    
    // Get email template
    const emailTemplate = templates[template];
    if (!emailTemplate) {
      throw new Error(`Email template '${template}' not found`);
    }

    // Replace template variables
    let html = emailTemplate;
    Object.keys(data).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, data[key]);
    });

    const mailOptions = {
      from: process.env.FROM_EMAIL || 'noreply@tweakmusic.com',
      to,
      subject,
      html
    };

    const info = await transporter.sendMail(mailOptions);
    
    logger.info('Email sent successfully', {
      to,
      subject,
      messageId: info.messageId
    });

    return info;
  } catch (error) {
    logger.error('Failed to send email', {
      to,
      subject,
      error: error.message
    });
    throw error;
  }
};

// Test email configuration
const testEmailConfig = async () => {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    logger.info('Email service configuration is valid');
    return true;
  } catch (error) {
    logger.error('Email service configuration error:', error);
    return false;
  }
};

module.exports = {
  sendEmail,
  testEmailConfig,
  templates
};
