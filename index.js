// index.js .

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser'); // Importar cookie-parser
const authorizedUsers = require('./authorizedUsers'); // Importar la lista de usuarios autorizados

const app = express();

// Configuración de CORS
const corsOptions = {
  origin: 'https://appraisers-frontend-856401495068.us-central1.run.app', // Reemplaza con la URL de tu frontend
  credentials: true, // Permitir el envío de cookies
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(cookieParser()); // Usar cookie-parser

// Configurar el cliente de OAuth2 con tu Client ID
const oauthClient = new OAuth2Client('856401495068-ica4bncmu5t8i0muugrn9t8t25nt1hb4.apps.googleusercontent.com'); // Tu Client ID

const client = new SecretManagerServiceClient();

// Función para acceder al secreto en Secret Manager
async function getJwtSecret() {
  const secretName = `projects/civil-forge-403609/secrets/jwt-secret/versions/latest`;

  const [version] = await client.accessSecretVersion({
    name: secretName,
  });

  const payload = version.payload.data.toString('utf8');
  return payload;
}

// Configurar la clave secreta para JWT desde Secret Manager
let JWT_SECRET;

(async () => {
  try {
    JWT_SECRET = await getJwtSecret();
    console.log('JWT_SECRET obtenido correctamente.');
  } catch (error) {
    console.error('Error al obtener JWT_SECRET:', error);
    process.exit(1); // Salir si no se puede obtener el secreto
  }
})();

// Función para verificar el ID token
async function verifyIdToken(idToken) {
  const ticket = await oauthClient.verifyIdToken({
    idToken: idToken,
    audience: '856401495068-ica4bncmu5t8i0muugrn9t8t25nt1hb4.apps.googleusercontent.com', // Tu Client ID
  });

  const payload = ticket.getPayload();
  return payload;
}

// Middleware de Autenticación y Autorización usando JWT desde la cookie
async function authenticate(req, res, next) {
  const token = req.cookies.jwtToken;

  if (!token) {
    return res.status(401).json({ success: false, message: 'No autorizado. Token no proporcionado.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Almacenar información del usuario en req.user

    // Verificar si el usuario está en la lista de autorizados
    if (!authorizedUsers.includes(decoded.email)) {
      return res.status(403).json({ success: false, message: 'Acceso prohibido. No tienes permisos para acceder a este recurso.' });
    }

    next();
  } catch (error) {
    console.error('Error al verificar el JWT:', error);
    res.status(401).json({ success: false, message: 'Token inválido.' });
  }
}

// Ruta de autenticación
app.post('/api/authenticate', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ success: false, message: 'ID Token es requerido.' });
  }

  try {
    const payload = await verifyIdToken(idToken);
    console.log('Usuario autenticado:', payload.email);

    // Generar un JWT propio
    const token = jwt.sign(
      {
        email: payload.email,
        name: payload.name,
        picture: payload.picture
      },
      JWT_SECRET,
      { expiresIn: '1h' } // Token válido por 1 hora
    );

    // Enviar el JWT como una cookie httpOnly
    res.cookie('jwtToken', token, {
      httpOnly: true,
      secure: true, // Asegúrate de que tu aplicación use HTTPS
      sameSite: 'Strict', // Ajusta según tus necesidades
      maxAge: 60 * 60 * 1000 // 1 hora
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error al verificar el ID Token:', error);
    res.status(401).json({ success: false, message: 'Autenticación fallida.' });
  }
});

// Ruta para cerrar sesión
app.post('/api/logout', (req, res) => {
  res.clearCookie('jwtToken', {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict'
  });
  res.json({ success: true, message: 'Sesión cerrada exitosamente.' });
});

// Función para inicializar la API de Google Sheets
async function initializeSheets() {
  try {
    console.log('Accediendo al secreto de la cuenta de servicio...');
    const serviceAccount = await getServiceAccount();
    console.log('Secreto accedido correctamente.');

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    console.log('Autenticado con la API de Google Sheets');
    return sheets;
  } catch (error) {
    console.error('Error al autenticar con la API de Google Sheets:', error);
    throw error; // Propagar el error para evitar iniciar el servidor
  }
}

// Función para acceder al secreto de servicio de cuenta
async function getServiceAccount() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT no está definido.');
  }

  const secretName = `projects/${projectId}/secrets/service-account-json/versions/latest`;

  const [version] = await client.accessSecretVersion({
    name: secretName,
  });

  const payload = version.payload.data.toString('utf8');
  return JSON.parse(payload);
}

// Función para configurar y iniciar el servidor
async function startServer() {
  try {
    const sheets = await initializeSheets();

    // ID de tu Google Sheet
    const SPREADSHEET_ID = '1PDdt-tEV78uMGW-813UTcVxC9uzrRXQSmNLCI1rR-xc';
    const SHEET_NAME = 'Pending Appraisals';

    // **Endpoint: Obtener Evaluaciones Pendientes**
    app.get('/api/appraisals', authenticate, async (req, res) => {
      // Ahora, solo los usuarios autenticados y autorizados pueden acceder a esta ruta
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A2:I`,
        });

        const rows = response.data.values || [];
        const appraisals = rows.map((row, index) => ({
          id: index + 2, // Número de fila en la hoja
          date: row[0] || '',
          appraisalType: row[1] || '',
          identifier: row[2] || '',
          email: row[3] || '',
          category: row[4] || '',
          status: row[5] || '',
          url: row[6] || '',
          currentDescription: row[7] || '',
          humanDescription: row[8] || '',
        }));

        res.json(appraisals);
      } catch (error) {
        console.error('Error al obtener evaluaciones:', error);
        res.status(500).send('Error al obtener evaluaciones');
      }
    });

    // **Endpoint: Actualizar Evaluación**
    app.post('/api/appraisals/:id', authenticate, async (req, res) => {
      // Solo usuarios autenticados y autorizados pueden actualizar evaluaciones
      const { id } = req.params; // Número de fila
      const { appraisalValue, humanDescription } = req.body;

      try {
        const updateRange = `${SHEET_NAME}!I${id}:J${id}`;
        const values = [[humanDescription, appraisalValue]];

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: updateRange,
          valueInputOption: 'RAW',
          resource: {
            values: values,
          },
        });

        res.send('Evaluación actualizada exitosamente');
      } catch (error) {
        console.error('Error al actualizar evaluación:', error);
        res.status(500).send('Error al actualizar evaluación');
      }
    });

    // **Ruta de Prueba Temporal para Verificar Conexión con Google Sheets**
    app.get('/api/test-sheets', async (req, res) => {
      try {
        const response = await sheets.spreadsheets.get({
          spreadsheetId: SPREADSHEET_ID,
        });
        res.send('Conexión exitosa con Google Sheets API');
      } catch (error) {
        console.error('Error al conectar con Google Sheets API:', error);
        res.status(500).send('Error al conectar con Google Sheets API');
      }
    });

    // **Iniciar el Servidor en Todas las Interfaces**
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Servidor backend está corriendo en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('Error al iniciar el servidor:', error);
    process.exit(1); // Salir si hay un error en la inicialización
  }
}

startServer();
