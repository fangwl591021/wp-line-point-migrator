<?php
/**
 * Plugin Name: WP LINE Point Exporter
 * Description: Read-only REST exporter for WordPress LINE-linked member and point migration.
 * Version: 0.1.0
 * Author: WP LINE Point Migrator
 */

if (!defined('ABSPATH')) {
    exit;
}

const WPLPM_OPTION_API_KEY = 'wplpm_exporter_api_key';
const WPLPM_OPTION_LINE_META_KEYS = 'wplpm_line_meta_keys';

function wplpm_default_line_meta_keys() {
    return array(
        'LINE_user_id',
        'line_user_id',
        'line_uid',
        'line_id',
        'line_userid',
        'line_login_user_id',
        'wetw_line_id',
        'wetw_line_user_id',
        'weline_line_user_id',
        'user_line_id',
    );
}

function wplpm_point_like_pattern() {
    return '/point|points|balance|credit|wallet|money|reward|gift|card|renew|expire|valid|shop|line/i';
}

function wplpm_get_api_key() {
    $api_key = get_option(WPLPM_OPTION_API_KEY);
    if (!$api_key) {
        $api_key = wp_generate_password(48, false, false);
        update_option(WPLPM_OPTION_API_KEY, $api_key, false);
    }

    return $api_key;
}

function wplpm_get_line_meta_keys() {
    $raw = get_option(WPLPM_OPTION_LINE_META_KEYS, '');
    if (!$raw) {
        return wplpm_default_line_meta_keys();
    }

    $keys = array_filter(array_map('trim', explode(',', $raw)));
    return $keys ? $keys : wplpm_default_line_meta_keys();
}

function wplpm_permission(WP_REST_Request $request) {
    $configured_key = wplpm_get_api_key();
    $request_key = $request->get_header('x-wplpm-api-key');

    if (!$request_key) {
        $request_key = $request->get_param('api_key');
    }

    return hash_equals($configured_key, (string) $request_key);
}

function wplpm_is_line_uid($value) {
    return is_string($value) && preg_match('/^U[a-fA-F0-9]{32}$/', $value);
}

function wplpm_find_line_uids($user_id) {
    $found = array();
    $preferred_keys = wplpm_get_line_meta_keys();

    foreach ($preferred_keys as $meta_key) {
        $value = get_user_meta($user_id, $meta_key, true);
        if (wplpm_is_line_uid($value)) {
            $found[$value] = $meta_key;
        }
    }

    $all_meta = get_user_meta($user_id);
    foreach ($all_meta as $meta_key => $values) {
        foreach ((array) $values as $value) {
            if (wplpm_is_line_uid($value)) {
                $found[$value] = $meta_key;
            }
        }
    }

    return array_map(
        function ($line_uid, $meta_key) {
            return array(
                'line_user_id' => $line_uid,
                'meta_key' => $meta_key,
            );
        },
        array_keys($found),
        array_values($found)
    );
}

function wplpm_collect_relevant_meta($user_id, $include_all_meta = false) {
    $meta = get_user_meta($user_id);
    $result = array();

    foreach ($meta as $key => $values) {
        if (!$include_all_meta && !preg_match(wplpm_point_like_pattern(), $key)) {
            continue;
        }

        $clean_values = array();
        foreach ((array) $values as $value) {
            if (is_string($value) && strlen($value) > 500) {
                $clean_values[] = substr($value, 0, 500) . '...';
            } else {
                $clean_values[] = maybe_unserialize($value);
            }
        }

        $result[$key] = count($clean_values) === 1 ? $clean_values[0] : $clean_values;
    }

    return $result;
}

function wplpm_user_to_array(WP_User $user, $include_meta = false, $include_all_meta = false) {
    $data = array(
        'wp_user_id' => (int) $user->ID,
        'user_login' => $user->user_login,
        'display_name' => $user->display_name,
        'email' => $user->user_email,
        'roles' => array_values((array) $user->roles),
        'line_user_ids' => wplpm_find_line_uids($user->ID),
    );

    if ($include_meta) {
        $data['meta'] = wplpm_collect_relevant_meta($user->ID, $include_all_meta);
    }

    return $data;
}

function wplpm_users(WP_REST_Request $request) {
    $page = max(1, (int) $request->get_param('page'));
    $per_page = min(200, max(1, (int) ($request->get_param('per_page') ?: 100)));
    $role = sanitize_text_field((string) $request->get_param('role'));
    $search = sanitize_text_field((string) $request->get_param('search'));
    $include_meta = (bool) $request->get_param('include_meta');
    $include_all_meta = (bool) $request->get_param('include_all_meta');

    $args = array(
        'number' => $per_page,
        'paged' => $page,
        'fields' => 'all',
        'count_total' => true,
    );

    if ($role) {
        $args['role'] = $role;
    }

    if ($search) {
        $args['search'] = '*' . $search . '*';
        $args['search_columns'] = array('user_login', 'user_email', 'display_name');
    }

    $query = new WP_User_Query($args);
    $users = array();

    foreach ($query->get_results() as $user) {
        $users[] = wplpm_user_to_array($user, $include_meta, $include_all_meta);
    }

    return rest_ensure_response(array(
        'success' => true,
        'page' => $page,
        'per_page' => $per_page,
        'total' => (int) $query->get_total(),
        'total_pages' => (int) ceil($query->get_total() / $per_page),
        'users' => $users,
    ));
}

function wplpm_user(WP_REST_Request $request) {
    $user_id = (int) $request->get_param('id');
    $user = get_user_by('id', $user_id);
    if (!$user) {
        return new WP_Error('wplpm_user_not_found', 'User not found', array('status' => 404));
    }

    return rest_ensure_response(array(
        'success' => true,
        'user' => wplpm_user_to_array($user, true, (bool) $request->get_param('include_all_meta')),
    ));
}

function wplpm_detect_meta(WP_REST_Request $request) {
    global $wpdb;

    $limit = min(500, max(1, (int) ($request->get_param('limit') ?: 100)));
    $like_keys = $wpdb->get_results(
        $wpdb->prepare(
            "SELECT meta_key, COUNT(*) as count_rows
             FROM {$wpdb->usermeta}
             WHERE meta_key REGEXP %s
             GROUP BY meta_key
             ORDER BY count_rows DESC
             LIMIT %d",
            'point|points|balance|credit|wallet|money|reward|gift|card|renew|expire|valid|shop|line',
            $limit
        ),
        ARRAY_A
    );

    $line_samples = $wpdb->get_results(
        $wpdb->prepare(
            "SELECT user_id, meta_key, meta_value
             FROM {$wpdb->usermeta}
             WHERE meta_value REGEXP %s
             LIMIT %d",
            '^U[a-fA-F0-9]{32}$',
            $limit
        ),
        ARRAY_A
    );

    return rest_ensure_response(array(
        'success' => true,
        'meta_keys' => $like_keys,
        'line_uid_samples' => $line_samples,
    ));
}

function wplpm_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }

    if (isset($_POST['wplpm_save'])) {
        check_admin_referer('wplpm_save');
        update_option(
            WPLPM_OPTION_LINE_META_KEYS,
            sanitize_text_field((string) wp_unslash($_POST['line_meta_keys'] ?? '')),
            false
        );
        echo '<div class="updated"><p>Saved.</p></div>';
    }

    $api_key = esc_html(wplpm_get_api_key());
    $meta_keys = esc_attr(implode(',', wplpm_get_line_meta_keys()));
    $users_endpoint = esc_url(rest_url('wp-line-point/v1/users'));
    $detect_endpoint = esc_url(rest_url('wp-line-point/v1/detect-meta'));

    echo '<div class="wrap">';
    echo '<h1>WP LINE Point Exporter</h1>';
    echo '<p><strong>Users endpoint:</strong> <code>' . $users_endpoint . '</code></p>';
    echo '<p><strong>Detect endpoint:</strong> <code>' . $detect_endpoint . '</code></p>';
    echo '<p><strong>API Key:</strong> <code>' . $api_key . '</code></p>';
    echo '<form method="post">';
    wp_nonce_field('wplpm_save');
    echo '<table class="form-table"><tr>';
    echo '<th scope="row"><label for="line_meta_keys">LINE meta keys</label></th>';
    echo '<td><input name="line_meta_keys" id="line_meta_keys" type="text" class="regular-text" value="' . $meta_keys . '">';
    echo '<p class="description">Comma-separated keys. The exporter also scans all user meta values for LINE UID format.</p></td>';
    echo '</tr></table>';
    submit_button('Save', 'primary', 'wplpm_save');
    echo '</form>';
    echo '</div>';
}

add_action('admin_menu', function () {
    add_options_page(
        'WP LINE Point Exporter',
        'WP LINE Point Exporter',
        'manage_options',
        'wp-line-point-exporter',
        'wplpm_settings_page'
    );
});

add_action('rest_api_init', function () {
    register_rest_route('wp-line-point/v1', '/users', array(
        'methods' => 'GET',
        'callback' => 'wplpm_users',
        'permission_callback' => 'wplpm_permission',
    ));

    register_rest_route('wp-line-point/v1', '/users/(?P<id>\\d+)', array(
        'methods' => 'GET',
        'callback' => 'wplpm_user',
        'permission_callback' => 'wplpm_permission',
    ));

    register_rest_route('wp-line-point/v1', '/detect-meta', array(
        'methods' => 'GET',
        'callback' => 'wplpm_detect_meta',
        'permission_callback' => 'wplpm_permission',
    ));
});
