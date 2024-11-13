const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { config } = require('../config');
const authorizedUsers = require('../constants/authorizedUsers');

class AuthController {
  static async authenticateUser(req, res) {
    try {
      const { email, password } = req.body;

      console.log('🔑 [authenticateUser] Login attempt:', { 
        email, 
        timestamp: new Date().toISOString() 
      });

      if (!email || !password) {
        return res.status(400).json({ 
          success: false, 
          message: 'Email and password are required.' 
        });
      }

      if (!authorizedUsers.includes(email)) {
        console.log('❌ [authenticateUser] Unauthorized email:', email);
        return res.status(403).json({ 
          success: false, 
          message: 'User not authorized.' 
        });
      }

      const hashedPassword = crypto
        .createHash('sha256')
        .update(password)
        .digest('hex');

      const expectedHash = crypto
        .createHash('sha256')
        .update('appraisily2024')
        .digest('hex');

      if (hashedPassword !== expectedHash) {
        console.log('❌ [authenticateUser] Invalid password attempt for:', email);
        return res.status(401).json({ 
          success: false, 
          message: 'Invalid credentials' 
        });
      }

      // Generate JWT token
      const token = jwt.sign(
        { email }, 
        config.JWT_SECRET,
        { expiresIn: '24h' }
      );

      // Set cookie options
      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      };

      console.log('🍪 [authenticateUser] Setting cookies with options:', cookieOptions);
      res.cookie('jwtToken', token, cookieOptions);

      console.log('✅ [authenticateUser] Login successful:', { 
        email, 
        timestamp: new Date().toISOString() 
      });

      res.json({
        success: true,
        name: 'Appraisily Admin',
        message: 'Login successful'
      });

    } catch (error) {
      console.error('❌ [authenticateUser] Error:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Internal server error' 
      });
    }
  }

  static logoutUser(req, res) {
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/'
    };

    res.clearCookie('jwtToken', cookieOptions);
    res.json({ 
      success: true, 
      message: 'Logout successful' 
    });
  }
}

module.exports = AuthController;