'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function(configuration) {
    const filePath = configuration.path;
    if (!filePath) return;

    console.log(`\n========================================`);
    console.log(`✒️ Custom Signing: ${filePath}`);
    console.log(`========================================`);

    // Load credentials from environment or fallback to secrets.json
    let tenantId = process.env.AZURE_TENANT_ID;
    let clientId = process.env.AZURE_CLIENT_ID;
    let clientSecret = process.env.AZURE_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
        const secretsPath = path.join(__dirname, 'secrets.json');
        if (fs.existsSync(secretsPath)) {
            try {
                const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
                tenantId = secrets.AZURE_TENANT_ID || tenantId;
                clientId = secrets.AZURE_CLIENT_ID || clientId;
                clientSecret = secrets.AZURE_CLIENT_SECRET || clientSecret;
            } catch (err) {
                console.error(`❌ Failed to read secrets.json:`, err);
            }
        }
    }

    if (!tenantId || !clientId || !clientSecret) {
        if (process.env.REQUIRE_SIGNING === 'true') {
            console.error(`❌ Error: Azure credentials not found in environment or secrets.json!`);
            throw new Error('Azure credentials missing for code signing');
        } else {
            console.warn(`⚠️ Warning: Azure credentials missing. Skipping code signing for this build.`);
            return;
        }
    }

    // Determine dotnet executable path
    let dotnetPath = process.env.DOTNET_PATH || 'dotnet';
    const localDotnet = "C:\\Users\\HossamabdelNabi\\.gemini\\antigravity\\ts\\dotnet\\dotnet.exe";
    if (fs.existsSync(localDotnet)) {
        dotnetPath = localDotnet;
    }

    // Determine sign tool path / arguments
    const localSignDll = "D:\\Omega Trove\\projects\\_mediumslateblue-snake-595521.hostingersite.com\\ts\\microsoft_sign_tool\\tools\\net8.0\\any\\sign.dll";
    const relativeSignDll = path.resolve(__dirname, '../../ts/microsoft_sign_tool/tools/net8.0/any/sign.dll');
    
    let signDllPath = process.env.SIGN_DLL_PATH;
    if (!signDllPath) {
        if (fs.existsSync(localSignDll)) {
            signDllPath = localSignDll;
        } else if (fs.existsSync(relativeSignDll)) {
            signDllPath = relativeSignDll;
        }
    }

    // Determine executable and args for signing
    let signExecutable = dotnetPath;
    let args = [];

    if (signDllPath) {
        // Run via dotnet host + sign.dll (local SDK / extracted tool)
        signExecutable = dotnetPath;
        args = [
            signDllPath,
            'code',
            'artifact-signing',
            '-ase', 'https://eus.codesigning.azure.net',
            '-asa', 'omegatrove-signing',
            '-ascp', 'omegatrove-public',
            filePath
        ];
    } else {
        // Check if Microsoft Sign CLI (sign.exe) was installed globally (e.g. in CI)
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        const globalSignExe = path.join(userProfile, '.dotnet', 'tools', 'sign.exe');
        const globalSign = path.join(userProfile, '.dotnet', 'tools', 'sign');

        if (fs.existsSync(globalSignExe)) {
            signExecutable = globalSignExe;
        } else if (fs.existsSync(globalSign)) {
            signExecutable = globalSign;
        } else {
            signExecutable = 'sign';
        }

        args = [
            'code',
            'artifact-signing',
            '-ase', 'https://eus.codesigning.azure.net',
            '-asa', 'omegatrove-signing',
            '-ascp', 'omegatrove-public',
            filePath
        ];
    }

    const env = {
        ...process.env,
        AZURE_TENANT_ID: tenantId,
        AZURE_CLIENT_ID: clientId,
        AZURE_CLIENT_SECRET: clientSecret
    };

    console.log(`Running Sign CLI (${signExecutable}) for: ${path.basename(filePath)}...`);
    const result = spawnSync(signExecutable, args, { env, stdio: 'inherit' });

    if (result.status !== 0) {
        console.error(`❌ Signing failed for: ${filePath}`);
        if (result.error) {
            console.error(result.error);
        }
        throw new Error(`Signing failed with exit code ${result.status}`);
    }

    console.log(`✅ Signing completed successfully for: ${path.basename(filePath)}`);
};

