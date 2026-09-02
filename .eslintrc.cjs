module.exports = {
    root: true,
    env: {
        node: true,
        es2023: true,
    },
    parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        requireConfigFile: false,
    },
    // required for eslint to understand ES6+ specific language features like "{ ...object }"
    parser: '@babel/eslint-parser',
    plugins: ['only-warn'],
    extends: ['plugin:prettier/recommended', 'eslint:recommended', 'plugin:import/errors', 'plugin:import/warnings'],
    settings: {
        'import/resolver': { node: { extensions: ['.js'] } },
    },
    rules: {
        'require-atomic-updates': 'off',
        'no-unused-vars': 'warn',
    },
};
